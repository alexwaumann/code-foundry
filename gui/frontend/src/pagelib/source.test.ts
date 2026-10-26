import { describe, expect, it } from "vitest";
import { absolutize, locate, scriptLine, tagMismatch } from "./source";

const BASE = "http://127.0.0.1:4000/preview/g/";

describe("absolutize (docs/notes/page-library-fixes-a.md)", () => {
  it("makes relative and root-relative import specifiers absolute", () => {
    const code = 'import a from "./a.js";\nimport "../b.js";\nexport { c } from "/c.js";\nconst d = await import("./d.js");\nimport { Button } from "@cf/ui";\n';
    expect(absolutize(code, BASE)).toBe(
      `import a from "${BASE}a.js";\nimport "http://127.0.0.1:4000/preview/b.js";\nexport { c } from "http://127.0.0.1:4000/c.js";\nconst d = await import("${BASE}d.js");\nimport { Button } from "@cf/ui";\n`,
    );
  });

  it("leaves strings that only read like imports alone", () => {
    const code = `const a = 'copied from "/tmp/report.txt"';\nconst b = "run: import './setup.js' first";\nconst from = "./x";\nf(from, "./y");\n`;
    expect(absolutize(code, BASE)).toBe(code);
  });

  it("keeps the specifier's quotes", () => {
    expect(absolutize("import x from './x';", BASE)).toBe(`import x from '${BASE}x';`);
  });
});

describe("tagMismatch", () => {
  it("is empty when every tag matches, fragments, members, self-closing and attribute JSX included", () => {
    expect(tagMismatch("const a = <div><b>hi</b><i/><><Foo.Bar x={<B/>}>t</Foo.Bar></></div>; const g = f<T>(x);")).toBe("");
  });

  it("names the closing tag that closes the wrong element, at its line", () => {
    const src = "function App() {\n  return (\n    <div>\n      <b>hello</div>\n    </div>\n  );\n}\n";
    expect(tagMismatch(src)).toBe("</div> closes <b>, opened at 4:6; expected </b> (4:14)");
  });

  it("finds it before the parser's own error further down", () => {
    const src = "function App() {\n  return <div>\n    <b>bold</div>\n  ;\n}\nconst y = 2;\n";
    expect(tagMismatch(src)).toMatch(/^<\/div> closes <b>.*\(3:11\)$/);
  });
});

describe("locate and scriptLine", () => {
  it("numbers the frame and the message from the script's line in the file", () => {
    const source = "\n  import x from 'y';\n  const App = () => <div>unclosed;\n";
    const r = locate(source, "Unexpected token, expected \";\" (3:34)", 9);
    expect(r.message).toBe('Unexpected token, expected ";" (11:34)');
    expect(r.frame).toBe("\n11 |   const App = () => <div>unclosed;\n" + " ".repeat(2 + 3 + 34) + "^");
  });

  it("finds each script's first line in document order", () => {
    const html = '<!doctype html>\n<script type="text/tsx">\nA\n</script>\n<script type="text/tsx">\nA\n</script>\n';
    const first = scriptLine(html, "\nA\n");
    expect(first.line).toBe(2);
    expect(scriptLine(html, "\nA\n", first.end).line).toBe(5);
    expect(scriptLine(html, "missing").line).toBe(0);
  });
});
