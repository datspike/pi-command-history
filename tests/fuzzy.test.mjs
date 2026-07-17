import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const sessionManagerStub = {
  list: async () => [],
  open: () => ({ getEntries: () => [] }),
};

function loadExtensionExports() {
  const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const exports = {};
  const module = { exports };
  const sandbox = {
    exports,
    module,
    require: (id) => {
      if (id === "@earendil-works/pi-coding-agent") {
        return {
          SessionManager: sessionManagerStub,
        };
      }
      if (id === "@earendil-works/pi-tui") {
        const decodeKittyPrintable = (data) => {
          const match = /^\u001b\[(\d+)u$/.exec(data);
          return match ? String.fromCodePoint(Number(match[1])) : undefined;
        };
        const matches = (data, key) => {
          const aliases = {
            "tui.select.up": "\u001b[A",
            "tui.select.down": "\u001b[B",
            "tui.select.pageUp": "\u001b[5~",
            "tui.select.pageDown": "\u001b[6~",
            "tui.select.confirm": "\r",
            "tui.select.cancel": ["\u001b", "\u0003"],
            "app.clear": "\u0003",
          };
          const value = aliases[key];
          return Array.isArray(value) ? value.includes(data) : value === data;
        };
        class Input {
          value = "";
          focused = false;
          onSubmit;
          onEscape;
          getValue() { return this.value; }
          setValue(value) { this.value = value; }
          handleInput(data) {
            if (data === "\r") return this.onSubmit?.(this.value);
            if (data === "\u001b") return this.onEscape?.();
            const printable = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
            if (printable && printable >= " ") this.value += printable;
          }
          render() { return [`> ${this.value}`]; }
          invalidate() {}
        }
        class SelectList {
          selectedIndex = 0;
          onSelect;
          onCancel;
          constructor(items) { this.items = items; }
          handleInput(data) {
            if (matches(data, "tui.select.up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
            else if (matches(data, "tui.select.down")) this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
            else if (matches(data, "tui.select.confirm")) this.onSelect?.(this.items[this.selectedIndex]);
            else if (matches(data, "tui.select.cancel")) this.onCancel?.();
          }
          render() { return this.items.map((item, index) => `${index === this.selectedIndex ? ">" : " "} ${item.label}`); }
          getSelectedItem() { return this.items[this.selectedIndex] ?? null; }
          invalidate() {}
        }
        return {
          getKeybindings: () => ({ matches }),
          Input,
          SelectList,
          isKeyRelease: (data) => data.includes(":3"),
          truncateToWidth: (text, width) => text.slice(0, width),
          visibleWidth: (text) => text.length,
        };
      }
      return require(id);
    },
  };

  vm.runInNewContext(compiled, sandbox, { filename: "extensions/index.ts" });
  return module.exports;
}

const { applyEditorText, buildHistoryItems, filterHistory, HistoryPicker, normalizeCommandDisplayText, safeRenderLine, scoreFuzzyMatch } = loadExtensionExports();

const fakeTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
};

const fakeKeybindings = {
  matches(data, key) {
    const aliases = {
      "tui.select.up": "\u001b[A",
      "tui.select.down": "\u001b[B",
      "tui.select.pageUp": "\u001b[5~",
      "tui.select.pageDown": "\u001b[6~",
      "tui.select.confirm": "\r",
      "tui.select.cancel": ["\u001b", "\u0003"],
      "tui.editor.cursorLeft": "\u001b[D",
      "tui.editor.cursorRight": "\u001b[C",
      "app.clear": "\u0003",
    };
    const value = aliases[key];
    return Array.isArray(value) ? value.includes(data) : value === data;
  },
};

test("scoreFuzzyMatch returns null when query characters are missing", () => {
  "Проверка отсутствия совпадения для неподходящего запроса.";
  assert.equal(scoreFuzzyMatch("npm test", "zz"), null);
});

test("scoreFuzzyMatch accepts subsequence matches", () => {
  "Проверка нечёткого совпадения по подпоследовательности.";
  const match = scoreFuzzyMatch("python manage.py test", "pmt");
  assert.notEqual(match, null);
  assert.deepEqual(Array.from(match.positions), [0, 7, 17]);
});

test("filterHistory prefers stronger textual match over recency", () => {
  "Проверка приоритета качества совпадения над свежестью команды.";
  const history = ["git status", "npm run typecheck", "pytest tests/test_history.py"];
  const matches = filterHistory(history, "npm", 3);
  assert.equal(matches[0].text, "npm run typecheck");
});

test("filterHistory keeps newest command first for empty query", () => {
  "Проверка порядка истории без запроса: новые команды идут первыми.";
  const history = ["old command", "middle command", "new command"];
  const matches = filterHistory(history, "", 3);
  assert.deepEqual(Array.from(matches, (match) => match.text), ["new command", "middle command", "old command"]);
});

test("HistoryPicker accepts Kitty CSI-u printable input", () => {
  "Проверка ввода печатных символов через Kitty keyboard protocol.";
  let selected = null;
  const picker = new HistoryPicker(fakeTheme, buildHistoryItems(["npm test", "git status"]), [], "", (value) => {
    selected = value;
  }, () => {}, fakeKeybindings);

  picker.handleInput("\u001b[110u");
  picker.handleInput("\u001b[112u");
  picker.handleInput("\u001b[109u");
  picker.handleInput("\r");

  assert.equal(selected, "npm test");
});

test("HistoryPicker cancels on ctrl-c without selecting command", () => {
  "Проверка отмены пикера через Ctrl-C без выбора команды.";
  let selected = "not-called";
  const picker = new HistoryPicker(fakeTheme, buildHistoryItems(["npm test", "git status"]), [], "", (value) => {
    selected = value;
  }, () => {}, fakeKeybindings);

  picker.handleInput("\u0003");

  assert.equal(selected, null);
});

test("safeRenderLine avoids terminal autowrap column", () => {
  "Проверка, что строка рендера не занимает последнюю колонку терминала.";
  assert.equal(safeRenderLine("x".repeat(20), 10).length, 9);
});

test("normalizeCommandDisplayText replaces newlines with spaces", () => {
  "Проверка одноcтрочного отображения многострочных команд.";
  assert.equal(normalizeCommandDisplayText("echo one\n  echo two\r\necho three"), "echo one echo two echo three");
});

test("HistoryPicker renders multiline commands without embedded newlines", () => {
  "Проверка, что переносы строк не попадают в отрисованные строки модалки.";
  const picker = new HistoryPicker(fakeTheme, buildHistoryItems(["echo one\necho two"]), [], "", () => {}, () => {}, fakeKeybindings);
  const lines = picker.render(40);
  assert.equal(lines.some((line) => line.includes("\n") || line.includes("\r")), false);
  assert.equal(lines.join("\n").includes("echo one echo two"), true);
});

test("HistoryPicker scrolls selected row horizontally with left and right arrows", () => {
  "Проверка быстрого горизонтального просмотра длинной выбранной команды.";
  const picker = new HistoryPicker(fakeTheme, buildHistoryItems(["abcdefghijklmnopqrstuvwxyz"]), [], "", () => {}, () => {}, fakeKeybindings);
  const before = picker.render(24).join("\n");

  picker.handleInput("\u001b[C");
  const afterRight = picker.render(24).join("\n");

  picker.handleInput("\u001b[D");
  const afterLeft = picker.render(24).join("\n");

  assert.notEqual(afterRight, before);
  assert.match(afterRight, /‹/);
  assert.match(afterRight, /klm/);
  assert.notEqual(afterLeft, afterRight);
});

test("HistoryPicker toggles into session starts mode on tab", () => {
  "Проверка переключения в режим стартовых промптов сессий по клавише Tab.";
  const picker = new HistoryPicker(
    fakeTheme,
    buildHistoryItems(["npm test", "git status"]),
    [
      { text: "initial project prompt", displayText: "initial project prompt · 2026-05-20", searchText: "initial project prompt" },
    ],
    "",
    () => {},
    () => {},
    fakeKeybindings,
  );

  picker.handleInput("\t");
  const lines = picker.render(60).join("\n");

  assert.match(lines, /Session starts/);
  assert.match(lines, /initial project prompt/);
  assert.doesNotMatch(lines, /git status/);
});

test("HistoryPicker filters only session starts after mode toggle", () => {
  "Проверка нечёткого поиска только по стартовым промптам после переключения режима.";
  const picker = new HistoryPicker(
    fakeTheme,
    buildHistoryItems(["npm test", "git status"]),
    [
      { text: "draft release note", displayText: "draft release note · 2026-05-20", searchText: "draft release note" },
      { text: "incident retrospective", displayText: "incident retrospective · 2026-05-19", searchText: "incident retrospective" },
    ],
    "",
    () => {},
    () => {},
    fakeKeybindings,
  );

  picker.handleInput("\t");
  picker.handleInput("d");
  picker.handleInput("r");
  const lines = picker.render(60).join("\n");

  assert.match(lines.toLowerCase(), /draft release note/);
  assert.doesNotMatch(lines, /incident retrospective/);
  assert.doesNotMatch(lines, /npm test/);
});

test("applyEditorText uses paste path for multiline value", () => {
  "Проверка вставки многострочного текста через pasteToEditor после очистки редактора.";
  const calls = [];
  const ctx = {
    ui: {
      setEditorText(text) { calls.push(["setEditorText", text]); },
      pasteToEditor(text) { calls.push(["pasteToEditor", text]); },
    },
  };

  applyEditorText(ctx, "line one\nline two");

  assert.deepEqual(calls, [
    ["setEditorText", ""],
    ["pasteToEditor", "line one\nline two"],
  ]);
});

test("loadSessionStartItems keeps original multiline prompt for insertion", async () => {
  "Проверка сохранения исходных переносов строк у стартового промпта сессии.";
  const { loadSessionStartItems } = loadExtensionExports();
  sessionManagerStub.list = async () => [{
    path: "/tmp/session-1.jsonl",
    name: "demo",
    modified: new Date("2026-05-20T12:00:00Z"),
    firstMessage: "line one line two",
  }];
  sessionManagerStub.open = () => ({
    getEntries: () => [{
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "line one\nline two" }],
      },
    }],
  });

  const items = await loadSessionStartItems("/tmp/project");

  assert.equal(items[0]?.text, "line one\nline two");
  assert.equal(items[0]?.displayText.includes("line one line two"), true);
});
