/**
 * Folder-based command history.
 *
 * Persists editor history per working directory so you can retrieve previous
 * commands across sessions. Use ctrl+up/down for linear browsing or ctrl+r for
 * fuzzy search.
 */

import { SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_DIR = join(homedir(), ".pi", "folder-history");
const MAX_HISTORY = 500;
const PICKER_MAX_RESULTS = 10;
const PICKER_OVERLAY_WIDTH = "92%";
const PICKER_OVERLAY_MIN_WIDTH = 40;
const PICKER_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const PICKER_STATIC_LINES = 6;
const HORIZONTAL_SCROLL_STEP = 10;
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;
const PRINTABLE_KITTY_KEY_PATTERN = /^\x1b\[(\d+)u$/;
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";

type PickerItem = {
  text: string;
  displayText: string;
  searchText: string;
};

type MatchResult = PickerItem & {
  score: number;
  positions: number[];
};

type PickerMode = "history" | "sessionStarts";

type PickerController = {
  close: () => void;
};

function getHistoryFile(cwd: string): string {
  const name = cwd.replace(/\//g, "-");
  return join(HISTORY_DIR, `${name}.jsonl`);
}

function loadHistory(cwd: string): string[] {
  const file = getHistoryFile(cwd);
  if (!existsSync(file)) return [];

  try {
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim());

    const entries: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.text && entry.cwd === cwd) {
          entries.push(entry.text);
        }
      } catch {
        // пропуск повреждённых строк истории
      }
    }

    const seen = new Map<string, number>();
    entries.forEach((text, index) => seen.set(text, index));
    const unique = [...seen.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([text]) => text);

    return unique.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function appendHistory(cwd: string, text: string): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const file = getHistoryFile(cwd);
  const entry = JSON.stringify({ cwd, text, ts: Date.now() });
  appendFileSync(file, entry + "\n", "utf-8");
}

export function normalizeCommandDisplayText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function scoreFuzzyMatch(item: string | PickerItem, query: string): MatchResult | null {
  const normalizedItem: PickerItem = typeof item === "string"
    ? {
      text: item,
      displayText: normalizeCommandDisplayText(item),
      searchText: normalizeCommandDisplayText(item),
    }
    : {
      ...item,
      displayText: normalizeCommandDisplayText(item.displayText),
      searchText: normalizeCommandDisplayText(item.searchText),
    };
  const normalizedQuery = normalizeCommandDisplayText(query).trim().toLowerCase();
  if (!normalizedQuery) {
    return { ...normalizedItem, score: 0, positions: [] };
  }

  const normalizedText = normalizedItem.searchText.toLowerCase();
  let searchFrom = 0;
  let score = 0;
  let previousIndex = -1;
  const positions: number[] = [];

  for (const char of normalizedQuery) {
    const index = normalizedText.indexOf(char, searchFrom);
    if (index === -1) return null;

    positions.push(index);

    if (index === previousIndex + 1) score += 8;
    if (index === 0 || /[\s/_:.-]/.test(normalizedItem.searchText[index - 1] ?? "")) score += 5;
    score -= index - previousIndex - 1;

    previousIndex = index;
    searchFrom = index + 1;
  }

  if (normalizedText.includes(normalizedQuery)) score += 30;
  if (normalizedText.startsWith(normalizedQuery)) score += 20;
  score -= Math.max(0, normalizedItem.searchText.length - normalizedQuery.length) / 100;

  return { ...normalizedItem, score, positions };
}

export function filterHistory(history: string[], query: string, maxResults = PICKER_MAX_RESULTS): MatchResult[] {
  return filterPickerItems(history.map((text) => ({
    text,
    displayText: normalizeCommandDisplayText(text),
    searchText: text,
  })), query, maxResults);
}

export function filterPickerItems(items: PickerItem[], query: string, maxResults = PICKER_MAX_RESULTS): MatchResult[] {
  return [...items]
    .reverse()
    .map((item, recencyIndex) => {
      const match = scoreFuzzyMatch(item, query);
      if (!match) return null;
      return { ...match, score: match.score - recencyIndex / 1000 };
    })
    .filter((match): match is MatchResult => match !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

export function buildHistoryItems(history: string[]): PickerItem[] {
  return history.map((text) => ({
    text,
    displayText: normalizeCommandDisplayText(text),
    searchText: text,
  }));
}

export async function loadSessionStartItems(cwd: string): Promise<PickerItem[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    return sessions
      .map((session) => {
        const originalPrompt = session.firstMessage ?? "";
        const displayPrompt = normalizeCommandDisplayText(originalPrompt);
        if (!displayPrompt) {
          return null;
        }

        const sessionLabel = session.name?.trim() || session.modified.toISOString().slice(0, 10);
        return {
          modifiedAt: session.modified.getTime(),
          item: {
            text: originalPrompt,
            displayText: `${displayPrompt} · ${sessionLabel}`,
            searchText: originalPrompt,
          },
        };
      })
      .filter((entry): entry is { modifiedAt: number; item: PickerItem } => entry !== null)
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
      .map(({ item }) => item);
  } catch {
    return [];
  }
}

function visibleSlice(text: string, positions: number[]): string {
  if (positions.length === 0) return text;

  const highlighted = new Set(positions);
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    result += highlighted.has(index) ? char.toUpperCase() : char;
  }
  return result;
}

export function safeRenderLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width - 1);
  return truncateToWidth(text, safeWidth, "…", true);
}

function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function decodePrintableInput(data: string): string | null {
  const kittyMatch = PRINTABLE_KITTY_KEY_PATTERN.exec(data);
  if (kittyMatch) {
    const codePoint = Number(kittyMatch[1]);
    if (!Number.isInteger(codePoint)) return null;
    const text = String.fromCodePoint(codePoint);
    return isPrintableText(text) ? text : null;
  }

  return isPrintableText(data) ? data : null;
}

function isPrintableText(text: string): boolean {
  if (text.length === 0) return false;

  return [...text].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  });
}

function removeLastGrapheme(text: string): string {
  const chars = [...text];
  chars.pop();
  return chars.join("");
}

type OverlayGeometry = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export class HistoryPicker implements Component, Focusable {
  private query = "";
  private selectedIndex = 0;
  private horizontalOffset = 0;
  private currentMatches: MatchResult[] = [];
  private mode: PickerMode = "history";
  private sessionStartItems: PickerItem[];
  private sessionStartsState: "idle" | "loading" | "loaded";
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly theme: Theme,
    private readonly historyItems: PickerItem[],
    sessionStartItems: PickerItem[],
    initialQuery: string,
    private readonly done: (value: string | null) => void,
    private readonly requestRender: () => void = () => {},
    private readonly keybindings: KeybindingsManager,
    private readonly tui?: TUI,
    private readonly loadSessionStarts?: () => Promise<PickerItem[]>,
  ) {
    this.sessionStartItems = sessionStartItems;
    this.sessionStartsState = sessionStartItems.length > 0 || !loadSessionStarts ? "loaded" : "idle";
    this.query = initialQuery.trim();
    this.refreshMatches();
  }

  getText(): string {
    return this.query;
  }

  getExpandedText(): string {
    return this.getText();
  }

  setText(text: string): void {
    this.query = text;
    this.refreshMatches();
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.clear")) {
      this.done(null);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.getMaxVisibleResults(), false);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.getMaxVisibleResults(), false);
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "\x1b[D") {
      this.scrollSelected(-HORIZONTAL_SCROLL_STEP);
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.cursorRight") || data === "\x1b[C") {
      this.scrollSelected(HORIZONTAL_SCROLL_STEP);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.acceptSelected();
      return;
    }

    if (data === "\t") {
      this.toggleMode();
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = removeLastGrapheme(this.query);
        this.refreshMatches();
        this.requestRender();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
      if (this.query.length > 0) {
        this.query = "";
        this.refreshMatches();
        this.requestRender();
      }
      return;
    }

    const printable = decodePrintableInput(data);
    if (printable) {
      this.query += printable;
      this.refreshMatches();
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
    const maxResults = this.getMaxVisibleResults();
    const rows = this.getVisibleRows(maxResults, innerWidth);
    const rawLines = [
      this.renderTitleLine(innerWidth),
      this.theme.fg("muted", "type filter · enter accept · esc/ctrl-c cancel · ↑/↓ move · ←/→ scroll · tab toggle sessions"),
      this.renderQueryLine(innerWidth),
      "",
      ...rows,
    ];

    while (rawLines.length < maxResults + PICKER_STATIC_LINES - 2) {
      rawLines.push("");
    }

    return [
      this.renderTopBorder(width),
      ...rawLines.slice(0, maxResults + PICKER_STATIC_LINES - 2).map((line) => this.renderBoxLine(line, innerWidth)),
      this.renderBottomBorder(width),
    ];
  }

  invalidate(): void {}

  private refreshMatches(): void {
    this.currentMatches = filterPickerItems(this.getActiveItems(), this.query, MAX_HISTORY);
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.currentMatches.length - 1));
    this.horizontalOffset = 0;
  }

  private getActiveItems(): PickerItem[] {
    return this.mode === "sessionStarts" ? this.sessionStartItems : this.historyItems;
  }

  private toggleMode(): void {
    if (this.mode === "history" && this.sessionStartItems.length === 0 && !this.loadSessionStarts) {
      return;
    }

    this.mode = this.mode === "history" ? "sessionStarts" : "history";
    this.refreshMatches();
    this.requestRender();
    if (this.mode === "sessionStarts") {
      void this.ensureSessionStartsLoaded();
    }
  }

  private async ensureSessionStartsLoaded(): Promise<void> {
    if (this.sessionStartsState !== "idle" || !this.loadSessionStarts) return;

    this.sessionStartsState = "loading";
    this.requestRender();
    try {
      this.sessionStartItems = await this.loadSessionStarts();
    } catch {
      this.sessionStartItems = [];
    } finally {
      this.sessionStartsState = "loaded";
      if (this.mode === "sessionStarts") this.refreshMatches();
      this.requestRender();
    }
  }

  private getMaxVisibleResults(): number {
    if (!this.tui) return PICKER_MAX_RESULTS;

    const overlayMaxHeight = Math.max(8, Math.floor(this.tui.terminal.rows * PICKER_OVERLAY_MAX_HEIGHT_RATIO));
    return Math.max(3, Math.min(PICKER_MAX_RESULTS, overlayMaxHeight - PICKER_STATIC_LINES));
  }

  private moveSelection(delta: number, wrap = true): void {
    const count = this.currentMatches.length;
    if (count === 0) return;

    if (wrap) {
      this.selectedIndex = (this.selectedIndex + delta + count) % count;
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, count - 1));
    }
    this.horizontalOffset = 0;
    this.requestRender();
  }

  private acceptSelected(): void {
    this.done(this.currentMatches[this.selectedIndex]?.text ?? null);
  }

  private getVisibleRows(maxRows: number, width: number): string[] {
    if (this.mode === "sessionStarts" && this.sessionStartsState === "loading") {
      return [this.theme.fg("dim", "Loading session starts…")];
    }
    if (this.currentMatches.length === 0) {
      const emptyText = this.mode === "sessionStarts" ? "No session starts" : "No matching commands";
      return [this.theme.fg("dim", emptyText)];
    }

    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxRows / 2), this.currentMatches.length - maxRows));
    const endIndex = Math.min(startIndex + maxRows, this.currentMatches.length);
    const rows: string[] = [];

    for (let index = startIndex; index < endIndex; index++) {
      const match = this.currentMatches[index];
      if (!match) continue;

      const selected = index === this.selectedIndex;
      const prefix = selected ? ">" : " ";
      const positionText = `${index + 1}.`;
      const position = this.theme.fg("dim", positionText);
      const prefixWidth = visibleWidth(`${prefix} ${positionText} `);
      const labelWidth = Math.max(1, width - prefixWidth);
      const highlightedLabel = visibleSlice(match.displayText, match.positions);
      const label = selected ? this.getHorizontalLabelSegment(highlightedLabel, labelWidth) : highlightedLabel;
      const line = `${prefix} ${position} ${label}`;
      rows.push(selected ? this.theme.fg("accent", this.theme.bold(line)) : this.theme.fg("text", line));
    }

    if (endIndex < this.currentMatches.length && rows.length < maxRows) {
      rows.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.currentMatches.length})`));
    }

    return rows.map((line) => truncateToWidth(line, width, "", true));
  }

  private renderTitleLine(width: number): string {
    const modeLabel = this.mode === "sessionStarts" ? "Session starts" : "Command history";
    const activeItems = this.getActiveItems();
    const title = this.theme.fg("accent", this.theme.bold(modeLabel));
    const count = this.theme.fg("muted", `${this.currentMatches.length}/${activeItems.length}`);
    const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(count));
    return title + " ".repeat(spacing) + count;
  }

  private scrollSelected(delta: number): void {
    const match = this.currentMatches[this.selectedIndex];
    if (!match) return;

    const maxOffset = Math.max(0, [...match.displayText].length - 1);
    this.horizontalOffset = Math.max(0, Math.min(this.horizontalOffset + delta, maxOffset));
    this.requestRender();
  }

  private getHorizontalLabelSegment(label: string, width: number): string {
    const chars = [...label];
    const prefix = this.horizontalOffset > 0 ? "‹" : "";
    const suffix = this.horizontalOffset + Math.max(0, width - prefix.length - 1) < chars.length ? "›" : "";
    const contentWidth = Math.max(1, width - prefix.length - suffix.length);
    const content = chars.slice(this.horizontalOffset).join("");
    return prefix + truncateToWidth(content, contentWidth, "", true) + suffix;
  }

  private renderQueryLine(width: number): string {
    const prompt = this.theme.fg("accent", "> ");
    const cursor = this._focused ? this.theme.fg("accent", "_") : "";
    return truncateToWidth(prompt + normalizeCommandDisplayText(this.query) + cursor, width, "", true);
  }

  private renderTopBorder(width: number): string {
    const inner = Math.max(0, width - 2);
    const title = " command_history ";
    if (inner < title.length + 2) {
      return this.theme.fg("accent", `╭${"─".repeat(inner)}╮`);
    }

    const remaining = inner - title.length - 1;
    return this.theme.fg("accent", "╭─") + this.theme.fg("dim", this.theme.bold(title)) + this.theme.fg("accent", `${"─".repeat(Math.max(0, remaining))}╮`);
  }

  private renderBottomBorder(width: number): string {
    const inner = Math.max(0, width - 2);
    return this.theme.fg("accent", `╰${"─".repeat(inner)}╯`);
  }

  private renderBoxLine(line: string, innerWidth: number): string {
    return this.theme.fg("accent", BOX_BORDER_LEFT) + padToWidth(line, innerWidth) + this.theme.fg("accent", BOX_BORDER_RIGHT);
  }
}

export class ManualOverlayHistoryPicker implements Component, Focusable {
  private readonly picker: HistoryPicker;
  private disposed = false;
  private drawTimer: ReturnType<typeof setTimeout> | undefined;
  private lastGeometry: OverlayGeometry | null = null;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.picker.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    historyItems: PickerItem[],
    sessionStartItems: PickerItem[],
    initialQuery: string,
    done: (value: string | null) => void,
    loadSessionStarts?: () => Promise<PickerItem[]>,
  ) {
    this.picker = new HistoryPicker(
      theme,
      historyItems,
      sessionStartItems,
      initialQuery,
      (selected) => {
        this.dispose();
        done(selected);
      },
      () => this.scheduleDraw(),
      keybindings,
      tui,
      loadSessionStarts,
    );
    this.scheduleDraw();
  }

  handleInput(_data: string): void {
    // ввод обрабатывается только через ctx.ui.onTerminalInput(), чтобы одно нажатие
    // не доходило до focused overlay-компонента второй раз
  }

  handleCapturedInput(data: string): void {
    if (this.disposed) return;

    this.picker.handleInput(data);
    this.scheduleDraw();
  }

  render(_width: number): string[] {
    this.scheduleDraw();
    return [];
  }

  invalidate(): void {
    this.picker.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = undefined;
    }
    this.restore(this.lastGeometry);
    this.lastGeometry = null;
  }

  private scheduleDraw(): void {
    if (this.disposed || this.drawTimer) return;

    this.drawTimer = setTimeout(() => {
      this.drawTimer = undefined;
      this.draw();
    }, 0);
  }

  private draw(): void {
    if (this.disposed) return;

    const geometry = this.getGeometry();
    const lines = this.picker.render(geometry.width).slice(0, geometry.height);
    let output = SYNC_OUTPUT_BEGIN + SAVE_CURSOR;
    output += this.getRestoreOutput(this.lastGeometry);
    for (let index = 0; index < geometry.height; index++) {
      const line = padToWidth(lines[index] ?? "", geometry.width);
      output += `\x1b[${geometry.top + index + 1};${geometry.left + 1}H${line}`;
    }
    output += RESTORE_CURSOR + SYNC_OUTPUT_END;
    this.tui.terminal.write(output);
    this.lastGeometry = geometry;
  }

  private restore(geometry: OverlayGeometry | null): void {
    if (!geometry) return;

    const output = SYNC_OUTPUT_BEGIN + SAVE_CURSOR + this.getRestoreOutput(geometry) + RESTORE_CURSOR + SYNC_OUTPUT_END;
    this.tui.terminal.write(output);
    this.tui.requestRender();
  }

  private getRestoreOutput(geometry: OverlayGeometry | null): string {
    if (!geometry) return "";

    const terminalWidth = this.tui.terminal.columns;
    const previousLines = (this.tui as unknown as { previousLines?: string[] }).previousLines ?? [];
    const viewportTop = (this.tui as unknown as { previousViewportTop?: number }).previousViewportTop
      ?? Math.max(0, previousLines.length - this.tui.terminal.rows);

    let output = "";
    for (let row = geometry.top; row < geometry.top + geometry.height; row++) {
      const originalLine = previousLines[viewportTop + row] ?? "";
      output += `\x1b[${row + 1};1H\x1b[2K${safeRenderLine(originalLine, terminalWidth)}`;
    }
    return output;
  }

  private getGeometry(): OverlayGeometry {
    const terminalWidth = Math.max(20, this.tui.terminal.columns);
    const terminalHeight = Math.max(8, this.tui.terminal.rows);
    const width = Math.max(
      Math.min(PICKER_OVERLAY_MIN_WIDTH, terminalWidth - 2),
      Math.min(Math.floor(terminalWidth * 0.92), terminalWidth - 2),
    );
    const renderedHeight = this.picker.render(width).length;
    const maxHeight = Math.max(6, Math.floor(terminalHeight * PICKER_OVERLAY_MAX_HEIGHT_RATIO));
    const height = Math.min(renderedHeight, maxHeight, terminalHeight - 2);

    return {
      top: Math.max(0, Math.floor((terminalHeight - height) / 2)),
      left: Math.max(0, Math.floor((terminalWidth - width) / 2)),
      width,
      height,
    };
  }

}

export function applyEditorText(ctx: ExtensionContext, text: string): void {
  if (/[\r\n]/.test(text)) {
    ctx.ui.setEditorText("");
    ctx.ui.pasteToEditor(text);
    return;
  }

  ctx.ui.setEditorText(text);
}

function openOverlayPicker(
  ctx: ExtensionContext,
  history: string[],
  loadSessionStarts: () => Promise<PickerItem[]>,
  onSelected: (text: string) => void,
  onClosed: () => void,
): PickerController {
  const initialText = ctx.ui.getEditorText();
  let closed = false;
  let finish: ((value: string | null) => void) | null = null;
  let picker: ManualOverlayHistoryPicker | null = null;
  let unsubscribeInput: (() => void) | null = null;

  const closeWith = (value: string | null) => {
    if (closed) return;
    closed = true;
    unsubscribeInput?.();
    unsubscribeInput = null;
    picker?.dispose();
    finish?.(value);
  };

  void ctx.ui
    .custom<string | null>(
      (tui, theme, keybindings, done) => {
        finish = done;
        picker = new ManualOverlayHistoryPicker(
          tui,
          theme,
          keybindings,
          buildHistoryItems(history),
          [],
          initialText,
          (selected) => closeWith(selected),
          loadSessionStarts,
        );
        unsubscribeInput = ctx.ui.onTerminalInput((data) => {
          if (closed) return undefined;

          if (isKeyRelease(data)) {
            return { consume: true };
          }

          picker?.handleCapturedInput(data);
          return { consume: true };
        });
        return picker;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: PICKER_OVERLAY_WIDTH,
          minWidth: PICKER_OVERLAY_MIN_WIDTH,
          maxHeight: "85%",
          margin: 1,
        },
      },
    )
    .then((selected) => {
      if (typeof selected === "string") {
        applyEditorText(ctx, selected);
        onSelected(selected);
      }
    })
    .finally(() => {
      unsubscribeInput?.();
      unsubscribeInput = null;
      picker?.dispose();
      onClosed();
    });

  return {
    close: () => closeWith(null),
  };
}

export default function (pi: ExtensionAPI) {
  let history: string[] = [];
  let historyIndex = -1;
  let savedEditorText = "";
  let currentCwd = "";
  let activePicker: PickerController | null = null;

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    history = loadHistory(currentCwd);
    historyIndex = -1;
    savedEditorText = "";
    activePicker = null;

    ctx.ui.setStatus(
      "folder-history",
      history.length > 0 ? `📜 ${history.length} cmds (ctrl+r, ctrl+↑/↓)` : undefined,
    );
  });

  pi.on("session_shutdown", () => {
    activePicker?.close();
    activePicker = null;
  });

  pi.on("input", (event, _ctx) => {
    const text = event.text?.trim();
    if (!text || !currentCwd) return;

    appendHistory(currentCwd, text);

    const index = history.indexOf(text);
    if (index !== -1) history.splice(index, 1);
    history.push(text);
    if (history.length > MAX_HISTORY) history.shift();

    historyIndex = -1;
    savedEditorText = "";

    return { action: "continue" as const };
  });

  pi.registerShortcut("ctrl+up", {
    description: "Previous command from folder history",
    handler: (ctx) => {
      if (history.length === 0 || activePicker) return;

      if (historyIndex === -1) {
        savedEditorText = ctx.ui.getEditorText();
      }

      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) return;

      historyIndex = nextIndex;
      applyEditorText(ctx, history[history.length - 1 - historyIndex]);
    },
  });

  pi.registerShortcut("ctrl+down", {
    description: "Next command from folder history",
    handler: (ctx) => {
      if (historyIndex <= -1 || activePicker) return;

      historyIndex--;

      if (historyIndex === -1) {
        applyEditorText(ctx, savedEditorText);
      } else {
        applyEditorText(ctx, history[history.length - 1 - historyIndex]);
      }
    },
  });

  pi.registerShortcut("ctrl+r", {
    description: "Fuzzy search folder command history",
    handler: (ctx) => {
      if (history.length === 0) {
        ctx.ui.notify("No folder command history yet", "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("Command history picker requires interactive UI", "warning");
        return;
      }

      if (activePicker) {
        activePicker.close();
        activePicker = null;
        return;
      }

      const pickerCwd = currentCwd;
      activePicker = openOverlayPicker(
        ctx,
        history,
        () => loadSessionStartItems(pickerCwd),
        () => {
          historyIndex = -1;
          savedEditorText = "";
        },
        () => {
          activePicker = null;
        },
      );
    },
  });
}
