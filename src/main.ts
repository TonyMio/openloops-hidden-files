/**
 * OpenLoops Hidden Files — reveal chosen dot-folders in Obsidian's native file tree.
 *
 * Obsidian's data adapter filters out any path starting with "." before it ever
 * becomes a TFile/TFolder, so dot-folders never appear in the file explorer,
 * search, or graph. This plugin monkey-patches two undocumented FileSystemAdapter
 * methods so that a *user-chosen* whitelist of dot-folders bypasses that filter
 * and is injected into the live vault cache. Injection is index-only — it never
 * writes to disk. Disabling a folder (or the plugin) removes the injected entries
 * and restores the original methods.
 *
 * Desktop-only: the whole mechanism depends on the Node-backed FileSystemAdapter,
 * which does not exist in mobile Obsidian.
 *
 * Technique derived from the MIT-licensed dsebastien/obsidian-hidden-folders-access.
 */
import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  type SettingDefinitionItem,
  SuggestModal,
  TAbstractFile,
  normalizePath,
} from "obsidian";
import { readdir, stat } from "node:fs/promises";

interface OpenLoopsHiddenFilesSettings {
  /** Vault-relative paths of dot-folders to reveal (e.g. ".github", ".claude"). */
  folders: string[];
}

const DEFAULT_SETTINGS: OpenLoopsHiddenFilesSettings = { folders: [] };

/* -------------------------------------------------------------------------- */
/* Undocumented adapter internals we rely on (desktop FileSystemAdapter only). */
/* -------------------------------------------------------------------------- */

type ReconcileFn = (fullPath: string, path: string, silent?: boolean) => Promise<void>;
type ListRecursiveChildFn = (parent: string, name: string) => Promise<void>;

interface InternalAdapter {
  watchers?: Record<string, unknown>;
  getFullRealPath(path: string): string;
  listRecursiveChild: ListRecursiveChildFn;
  reconcileFile: ReconcileFn;
  reconcileFileInternal(fullPath: string, path: string): Promise<void>;
  reconcileFolderCreation(fullPath: string, path: string): Promise<void>;
  reconcileDeletion(fullPath: string, path: string, force?: boolean): Promise<void>;
  watchHiddenRecursive(path: string): Promise<void>;
  stopWatchPath?(path: string): void;
  trigger?(event: string, ...args: unknown[]): void;
}

/** The internal methods that must exist for the patch to work. */
const REQUIRED_METHODS = [
  "listRecursiveChild",
  "reconcileFile",
  "reconcileFileInternal",
  "reconcileFolderCreation",
  "reconcileDeletion",
  "watchHiddenRecursive",
] as const;

const hasFsENOENT = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";

/**
 * Reject paths that could escape the vault. `normalizePath` does not collapse
 * ".." segments, so a hand-typed "../../secret" would otherwise resolve outside
 * the vault when passed to the adapter. We require a non-empty, relative path
 * with no "." or ".." segments before it is ever injected.
 */
const isSafeVaultPath = (normalizedPath: string): boolean => {
  if (normalizedPath.length === 0) return false;
  return normalizedPath.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, 0));

/* -------------------------------------------------------------------------- */
/* Indexer: patch + inject + un-inject.                                       */
/* -------------------------------------------------------------------------- */

class HiddenFolderIndexer {
  private readonly enabledPrefixes = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private patches: { list: ListRecursiveChildFn; reconcile: ReconcileFn } | null = null;

  constructor(private readonly app: App) {}

  /** True once the runtime guard has confirmed the required internals exist. */
  isSupported(): boolean {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return false;
    const adapter = this.internalAdapter();
    return REQUIRED_METHODS.every(
      (m) => typeof (adapter as unknown as Record<string, unknown>)[m] === "function",
    );
  }

  getEnabledPrefixes(): readonly string[] {
    return Array.from(this.enabledPrefixes);
  }

  /** Reconcile the live set of enabled folders to exactly `paths`. */
  async sync(paths: readonly string[]): Promise<void> {
    const wanted = new Set(paths.map((p) => this.normalize(p)).filter((p) => p.length > 0));
    for (const existing of Array.from(this.enabledPrefixes)) {
      if (!wanted.has(existing)) await this.disablePath(existing);
    }
    for (const target of wanted) {
      if (!this.enabledPrefixes.has(target)) await this.enablePath(target);
    }
  }

  /** True when a raw user path is safe to reveal (relative, no vault escape). */
  isAcceptablePath(rawPath: string): boolean {
    return isSafeVaultPath(this.normalize(rawPath));
  }

  async enablePath(rawPath: string): Promise<void> {
    const path = this.normalize(rawPath);
    if (path.length === 0 || this.enabledPrefixes.has(path)) return;
    if (!isSafeVaultPath(path)) {
      console.warn(`[openloops-hidden-files] refusing unsafe path "${rawPath}"`);
      return;
    }
    const running = this.inFlight.get(path);
    if (running) return running;
    const task = this.runEnable(path);
    this.inFlight.set(path, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async runEnable(path: string): Promise<void> {
    const adapter = this.internalAdapter();
    if (!(await this.existsOnDisk(path))) {
      // Configured folder is missing on disk — skip silently; a later sync
      // (restart / rescan) will pick it up if it reappears.
      return;
    }

    this.enabledPrefixes.add(path);
    this.ensurePatched();

    try {
      await adapter.reconcileFolderCreation(path, path);
    } catch (err) {
      this.enabledPrefixes.delete(path);
      console.error(`[openloops-hidden-files] failed to inject "${path}"`, err);
      throw err;
    }

    try {
      await adapter.watchHiddenRecursive(path);
    } catch (err) {
      console.warn(`[openloops-hidden-files] watcher failed for "${path}"`, err);
    }
  }

  async disablePath(rawPath: string): Promise<void> {
    const path = this.normalize(rawPath);
    if (!this.enabledPrefixes.has(path)) return;
    const running = this.inFlight.get(path);
    if (running) return running;
    const task = this.runDisable(path);
    this.inFlight.set(path, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async runDisable(path: string): Promise<void> {
    const adapter = this.internalAdapter();

    // Stop any watchers we registered under this prefix.
    for (const key of Object.keys(adapter.watchers ?? {})) {
      if (this.isUnderPrefix(key, path)) {
        try {
          adapter.stopWatchPath?.(key);
        } catch (err) {
          console.warn(`[openloops-hidden-files] failed to stop watcher "${key}"`, err);
        }
      }
    }

    // Remove injected entries bottom-up (children before parents) so folders are
    // empty before deletion. Yield periodically to keep the UI responsive.
    const toRemove = this.app.vault
      .getAllLoadedFiles()
      .filter((f: TAbstractFile) => this.isUnderPrefix(f.path, path))
      .sort((a, b) => b.path.length - a.path.length);

    for (let i = 0; i < toRemove.length; i++) {
      const file = toRemove[i];
      if (!file) continue;
      try {
        adapter.trigger?.("raw", file.path);
        await adapter.reconcileDeletion(file.path, file.path, true);
      } catch (err) {
        console.warn(`[openloops-hidden-files] failed to remove "${file.path}"`, err);
      }
      if ((i + 1) % 250 === 0) await yieldToEventLoop();
    }

    this.enabledPrefixes.delete(path);
    if (this.enabledPrefixes.size === 0) this.restorePatches();
  }

  /** Remove every patch and injected entry. Safe to call on unload. */
  async teardown(): Promise<void> {
    for (const path of Array.from(this.enabledPrefixes)) await this.disablePath(path);
    this.restorePatches();
  }

  private ensurePatched(): void {
    if (this.patches !== null) return;
    const adapter = this.internalAdapter();
    const originalList = adapter.listRecursiveChild.bind(adapter);
    const originalReconcile = adapter.reconcileFile.bind(adapter);
    const isEnabled = (p: string | undefined): boolean =>
      typeof p === "string" && this.isAnyEnabled(p);

    adapter.listRecursiveChild = async (parent: string, name: string): Promise<void> => {
      const combined = this.normalize(parent === "" ? name : `${parent}/${name}`);
      if (!isEnabled(combined)) return originalList(parent, name);
      adapter.trigger?.("raw", combined);
      try {
        await adapter.reconcileFileInternal(combined, combined);
      } catch (err) {
        if (hasFsENOENT(err)) await adapter.reconcileDeletion(combined, combined, true);
        else console.warn(`[openloops-hidden-files] listRecursiveChild "${combined}"`, err);
      }
    };

    adapter.reconcileFile = async (e: string, t: string, silent?: boolean): Promise<void> => {
      if (!isEnabled(t)) return originalReconcile(e, t, silent);
      const flag = silent ?? true;
      adapter.trigger?.("raw", t);
      try {
        await adapter.reconcileFileInternal(e, t);
      } catch (err) {
        if (hasFsENOENT(err)) await adapter.reconcileDeletion(e, t, flag);
        else console.warn(`[openloops-hidden-files] reconcileFile "${t}"`, err);
      }
    };

    this.patches = { list: originalList, reconcile: originalReconcile };
  }

  private restorePatches(): void {
    if (this.patches === null) return;
    const adapter = this.internalAdapter();
    adapter.listRecursiveChild = this.patches.list;
    adapter.reconcileFile = this.patches.reconcile;
    this.patches = null;
  }

  /** List dot-folders at the vault root, excluding Obsidian's config dir. */
  async listHiddenRootFolders(): Promise<string[]> {
    const base = this.basePath();
    if (base === null) return [];
    const configDir = normalizePath(this.app.vault.configDir);
    try {
      const entries = await readdir(base, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name.startsWith(".") && e.name !== configDir)
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async existsOnDisk(path: string): Promise<boolean> {
    const full = this.fullPath(path);
    if (full === null) return false;
    try {
      const s = await stat(full);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  private isAnyEnabled(path: string): boolean {
    for (const prefix of this.enabledPrefixes) if (this.isUnderPrefix(path, prefix)) return true;
    return false;
  }

  private isUnderPrefix(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  private normalize(path: string): string {
    return normalizePath(path).replace(/^\/+|\/+$/g, "");
  }

  private basePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  private fullPath(path: string): string | null {
    const adapter = this.internalAdapter();
    try {
      return adapter.getFullRealPath(path);
    } catch {
      const base = this.basePath();
      return base === null ? null : `${base}/${path}`;
    }
  }

  private internalAdapter(): InternalAdapter {
    return this.app.vault.adapter as unknown as InternalAdapter;
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin + settings tab.                                                     */
/* -------------------------------------------------------------------------- */

export default class OpenLoopsHiddenFilesPlugin extends Plugin {
  settings: OpenLoopsHiddenFilesSettings = { ...DEFAULT_SETTINGS };
  indexer!: HiddenFolderIndexer;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.indexer = new HiddenFolderIndexer(this.app);
    this.addSettingTab(new OpenLoopsHiddenFilesSettingTab(this.app, this));

    if (!this.indexer.isSupported()) {
      new Notice(
        "OpenLoops Hidden Files: this Obsidian build does not expose the required " +
          "filesystem internals (mobile or an unexpected version). Plugin inactive.",
      );
      return;
    }

    // Inject after the vault has finished its own initial load, so our entries
    // are added on top of a fully-reconciled cache.
    this.app.workspace.onLayoutReady(() => {
      void this.applyFolders();
    });

    this.addCommand({
      id: "rescan-hidden-folders",
      name: "Rescan hidden folders",
      callback: () => void this.applyFolders(),
    });
  }

  onunload(): void {
    // Plugin.onunload is synchronous; fire-and-forget the async teardown.
    void this.indexer?.teardown();
  }

  /** Re-sync the injected set to the current settings. */
  async applyFolders(): Promise<void> {
    if (!this.indexer.isSupported()) return;
    try {
      await this.indexer.sync(this.settings.folders);
    } catch (err) {
      console.error("[openloops-hidden-files] sync failed", err);
      new Notice("Could not update hidden folders — see the developer console.");
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<OpenLoopsHiddenFilesSettings> | null;
    const folders = loaded && Array.isArray(loaded.folders) ? loaded.folders : [];
    this.settings = { folders };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class OpenLoopsHiddenFilesSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OpenLoopsHiddenFilesPlugin,
  ) {
    super(app, plugin);
  }

  // Declarative settings (Obsidian 1.13+): describe the settings, not the DOM.
  // Obsidian renders, indexes them for settings-search, and calls update() re-runs.
  getSettingDefinitions(): SettingDefinitionItem[] {
    if (!this.plugin.indexer.isSupported()) {
      return [
        {
          name: "Plugin inactive",
          desc:
            "This Obsidian build does not expose the filesystem internals this " +
            "plugin needs (mobile, or an unexpected desktop version).",
          searchable: false,
        },
      ];
    }

    return [
      {
        name: "Revealed dot-folders",
        desc:
          "Revealed folders also join search and the graph and become readable by " +
          "every other installed plugin, so do not reveal folders that hold secrets " +
          "or credentials. Avoid large version-control folders too; scanning them " +
          "can freeze Obsidian.",
        searchable: false,
      },
      {
        type: "list",
        heading: "Folders",
        emptyState: "No folders revealed yet. Use the + button to add one.",
        items: this.plugin.settings.folders.map((folder) => ({ name: folder })),
        onDelete: (index: number) => {
          void this.removeAt(index);
        },
        addItem: {
          name: "Add folder",
          action: () => {
            void this.openAddFlow();
          },
        },
      },
    ];
  }

  private async removeAt(index: number): Promise<void> {
    const folders = this.plugin.settings.folders;
    if (index < 0 || index >= folders.length) return;
    folders.splice(index, 1);
    await this.plugin.saveSettings();
    await this.plugin.applyFolders();
    this.update();
  }

  private async addFolder(rawValue: string): Promise<void> {
    const value = rawValue.trim();
    if (value.length === 0) return;
    if (!this.plugin.indexer.isAcceptablePath(value)) {
      new Notice("Enter a folder inside the vault (no '..' or absolute paths).");
      return;
    }
    if (this.plugin.settings.folders.includes(value)) {
      new Notice("That folder is already revealed.");
      return;
    }
    this.plugin.settings.folders.push(value);
    await this.plugin.saveSettings();
    await this.plugin.applyFolders();
    this.update();
  }

  private async openAddFlow(): Promise<void> {
    const detected = (await this.plugin.indexer.listHiddenRootFolders()).filter(
      (d) => !this.plugin.settings.folders.includes(d),
    );
    new AddFolderModal(this.app, detected, (value) => {
      void this.addFolder(value);
    }).open();
  }
}

/**
 * Suggester for the "+" affordance: lists detected hidden root folders, and
 * offers the raw query as a custom entry so any vault-relative path can be added.
 */
class AddFolderModal extends SuggestModal<string> {
  constructor(
    app: App,
    private readonly detected: string[],
    private readonly onChoose: (value: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick a detected folder or type a vault-relative path");
  }

  getSuggestions(query: string): string[] {
    const q = query.trim();
    const matches = this.detected.filter((d) => d.toLowerCase().includes(q.toLowerCase()));
    if (q.length > 0 && !this.detected.includes(q)) {
      return [q, ...matches];
    }
    return matches;
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  onChooseSuggestion(value: string): void {
    this.onChoose(value);
  }
}
