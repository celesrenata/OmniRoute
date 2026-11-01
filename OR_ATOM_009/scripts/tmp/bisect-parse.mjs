import ts from "typescript";
import fs from "node:fs";
const full = fs.readFileSync("src/plugins/atomic-topology/dev/demoController.ts", "utf8");
const sf = ts.createSourceFile("f.ts", full, ts.ScriptTarget.ES2022, true);
// Walk tokens, print every comment node with line range
function walk(node) {
  for (const child of node.getChildren ? node.getChildren(sf) : []) {
    if (child.kind === ts.SyntaxKind.FirstPunctuation) {
      const start = sf.getLineAndCharacterOfPosition(child.getStart());
      const end = sf.getLineAndCharacterOfPosition(child.getEnd());
      if (start.line !== end.line) {
        console.log(
          `comment node L${start.line + 1}..L${end.line + 1} text=${JSON.stringify(full.slice(child.getStart(), Math.min(child.getEnd(), child.getStart() + 40)))}...`
        );
      }
    }
    walk(child);
  }
}
walk(sf);
