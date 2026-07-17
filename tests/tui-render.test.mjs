import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import xtermHeadless from "@xterm/headless";
const { Terminal: XTerm } = xtermHeadless;
import { KeybindingsManager, setKeybindings, TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

const require = createRequire(import.meta.url);

async function loadExtensionExports() {
  const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledPath = new URL("./.tmp-extension-under-test.mjs", import.meta.url);
  mkdirSync(new URL("./", compiledPath), { recursive: true });
  writeFileSync(compiledPath, compiled);
  return import(`${compiledPath.href}?t=${Date.now()}`);
}

class HeadlessTerminal {
  constructor(cols = 100, rows = 24) {
    this.columns = cols;
    this.rows = rows;
    this.xterm = new XTerm({ cols, rows, allowProposedApi: true, scrollback: 200 });
  }

  start(onInput, _onResize) {
    this.onInput = onInput;
  }

  stop() {}
  drainInput() { return Promise.resolve(); }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  moveBy(lines) { this.write(lines < 0 ? `\x1b[${-lines}A` : `\x1b[${lines}B`); }
  get kittyProtocolActive() { return false; }

  write(data) {
    this.xterm.write(data);
  }

  send(data) {
    this.onInput?.(data);
  }

  screenText() {
    const lines = [];
    const buffer = this.xterm.buffer.active;
    for (let row = 0; row < this.rows; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  fullBufferText() {
    const lines = [];
    const buffer = this.xterm.buffer.active;
    for (let row = 0; row < buffer.length; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }
}

function createTheme() {
  return {
    bg: (_color, text) => text,
    bold: (text) => text,
    fg: (_color, text) => text,
  };
}

function waitForRender() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

test("HistoryPicker arrow navigation updates screen in place without scrollback growth", async () => {
  "Проверка, что стрелки не дописывают копии пикера в историю терминала.";
  const { buildHistoryItems, HistoryPicker } = await loadExtensionExports();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);

  let selected = undefined;
  const terminal = new HeadlessTerminal(100, 24);
  const tui = new TUI(terminal);
  const picker = new HistoryPicker(
    createTheme(),
    buildHistoryItems([
      "old command",
      "middle command",
      "new command",
      "npm test",
      "npm run typecheck",
    ]),
    [],
    "",
    (value) => { selected = value; },
    () => tui.requestRender(),
    keybindings,
    tui,
  );

  tui.addChild(picker);
  tui.setFocus(picker);
  tui.start();
  await waitForRender();

  const beforeBufferLength = terminal.xterm.buffer.active.length;
  terminal.send("\x1b[B");
  await waitForRender();
  terminal.send("\x1b[B");
  await waitForRender();

  const screen = terminal.screenText();
  const fullBuffer = terminal.fullBufferText();
  assert.equal(selected, undefined);
  assert.equal(terminal.xterm.buffer.active.length, beforeBufferLength);
  assert.equal((fullBuffer.match(/Command history/g) ?? []).length, 1);
  assert.equal((screen.match(/type filter/g) ?? []).length, 1);
});

test("ManualOverlayHistoryPicker arrow navigation does not push chat content into scrollback", async () => {
  "Проверка ручной рамочной модалки поверх длинного чата.";
  const { buildHistoryItems, ManualOverlayHistoryPicker } = await loadExtensionExports();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);

  const terminal = new HeadlessTerminal(100, 24);
  const tui = new TUI(terminal);
  tui.addChild({
    invalidate() {},
    render(width) {
      return Array.from({ length: 40 }, (_value, index) => `chat line ${String(index + 1).padStart(2, "0")}`.padEnd(width, " "));
    },
  });

  const picker = new ManualOverlayHistoryPicker(
    tui,
    createTheme(),
    keybindings,
    buildHistoryItems(["old command", "middle command", "new command", "npm test", "npm run typecheck"]),
    [],
    "",
    () => {},
  );
  const overlay = tui.showOverlay(picker, {
    anchor: "center",
    width: "92%",
    minWidth: 40,
    maxHeight: "85%",
    margin: 1,
  });
  tui.start();
  await waitForRender();

  assert.match(terminal.screenText(), /Command history/);
  const beforeYbase = terminal.xterm.buffer.active.baseY;
  const beforeHistoryTitles = terminal.fullBufferText().match(/Command history/g)?.length ?? 0;

  picker.handleCapturedInput("\x1b[B");
  await waitForRender();
  picker.handleCapturedInput("\x1b[B");
  await waitForRender();

  const afterYbase = terminal.xterm.buffer.active.baseY;
  const afterHistoryTitles = terminal.fullBufferText().match(/Command history/g)?.length ?? 0;
  assert.equal(afterYbase, beforeYbase);
  assert.equal(afterHistoryTitles, beforeHistoryTitles);

  picker.dispose();
  overlay.hide();
});
