import fs from "node:fs";
const src = fs.readFileSync("src/plugins/atomic-topology/dev/demoController.ts", "utf8");
let inBlock = false,
  inLine = false,
  inStr = null;
let line = 1;
for (let j = 0; j < src.length; j++) {
  const ch = src[j];
  const two = src.slice(j, j + 2);
  if (ch === "\n") {
    line++;
    inLine = false;
    continue;
  }
  if (inLine) continue;
  if (inStr) {
    if (ch === "\\") j++;
    else if (ch === inStr) inStr = null;
    continue;
  }
  if (inBlock) {
    if (two === "*/") {
      inBlock = false;
      j++;
    }
    continue;
  }
  if (two === "//") {
    inLine = true;
    continue;
  }
  if (two === "/*") {
    inBlock = true;
    j++;
    console.log(`block comment OPEN at line ${line}`);
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    inStr = ch;
    continue;
  }
}
console.log("end: inBlock =", inBlock, "inStr =", inStr);
if (inBlock) {
  // find where the unclosed comment started by scanning from the last closing */
  const m = [...src.matchAll(/\/\*\*/g)];
  const closes = [...src.matchAll(/\*\//g)];
  console.log("count /* ==", m.length, "count */ ==", closes.length);
  m.forEach((mm) => {
    const ln = src.slice(0, mm.index).split("\n").length;
    console.log(`open /* at line ${ln}`);
  });
}
