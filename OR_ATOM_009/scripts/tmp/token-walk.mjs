import ts from "typescript";
import fs from "node:fs";
const src = fs.readFileSync("src/plugins/atomic-topology/dev/demoController.ts", "utf8");
const sf = ts.createSourceFile("f.ts", src, ts.ScriptTarget.ES2022, true);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.ScriptTarget.ES2022, src);
let pos = 0;
let last = null;
const interesting = [];
while (true) {
  const t = scanner.scan();
  if (t === ts.SyntaxKind.EndOfFileToken) break;
  const startPos = scanner.getTokenStart();
  const endPos = scanner.getTokenEnd();
  const ln = sf.getLineAndCharacterOfPosition(startPos).line + 1;
  if (ln >= 118 && ln <= 146) {
    interesting.push(
      `L${ln} ${ts.SyntaxKind[t]} ${JSON.stringify(src.slice(startPos, Math.min(endPos, startPos + 60)))}`
    );
  }
  last = t;
  scanner.setTextPos(endPos);
}
console.log(interesting.join("\n"));
