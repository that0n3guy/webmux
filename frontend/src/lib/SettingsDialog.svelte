<script lang="ts">
  import type { ThemeKey } from "./themes";
  import { SSH_STORAGE_KEY, applyTheme, errorMessage } from "./utils";
  import { THEMES } from "./themes";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";
  import Toggle from "./Toggle.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import AgentEditorDialog from "./AgentEditorDialog.svelte";
  import { api, fetchPreferences, updatePreferences } from "./api";
  import type { AgentSummary, UpdateUserPreferencesRequest, UserPreferences } from "./types";

  interface AgentEditorState {
    mode: "create" | "edit";
    agentId?: string;
    title: string;
    initialValue: {
      label: string;
      startCommand: string;
      resumeCommand: string;
    };
  }

  let {
    projectId,
    currentTheme,
    linearAutoCreate,
    autoRemoveOnMerge,
    onthemechange,
    onlinearautocreatechange,
    onautoremovechange,
    onagentschange,
    onsave,
    onclose,
  }: {
    projectId: string;
    currentTheme: ThemeKey;
    linearAutoCreate: boolean;
    autoRemoveOnMerge: boolean;
    onthemechange: (key: ThemeKey) => void;
    onlinearautocreatechange: (enabled: boolean) => void;
    onautoremovechange: (enabled: boolean) => void;
    onagentschange: (agents: AgentSummary[]) => void;
    onsave: (sshHost: string) => void;
    onclose: () => void;
  } = $props();

  let tab = $state<"global" | "project">("global");
  let sshHost = $state(localStorage.getItem(SSH_STORAGE_KEY) ?? "");

  // Project tab toggles
  let pendingAutoCreate = $state<boolean | null>(null);
  let autoCreate = $derived(pendingAutoCreate ?? linearAutoCreate);
  let autoCreateSaving = $state(false);

  let pendingAutoRemove = $state<boolean | null>(null);
  let autoRemove = $derived(pendingAutoRemove ?? autoRemoveOnMerge);
  let autoRemoveSaving = $state(false);

  // Global tab — preferences
  let prefs = $state<UserPreferences | null>(null);
  let prefsLoading = $state(true);
  let prefsError = $state<string | null>(null);
  let prefsSaving = $state(false);

  // Derived fields bound to form inputs (copied from prefs on load)
  let defaultAgent = $state<string>("");
  let autoNameModel = $state<string>("");
  let autoNameSystemPrompt = $state<string>("");

  // Global custom agents editor
  let editor = $state<AgentEditorState | null>(null);
  let deleteCandidate = $state<{ id: string; label: string } | null>(null);
  let deletingAgentId = $state<string | null>(null);

  let customAgentEntries = $derived(
    prefs?.agents ? Object.entries(prefs.agents) : [],
  );

  let prefsLoaded = false;

  $effect(() => {
    if (prefsLoaded) return;
    prefsLoaded = true;
    void loadPrefs();
  });

  async function loadPrefs(): Promise<void> {
    prefsLoading = true;
    prefsError = null;
    try {
      prefs = await fetchPreferences();
      defaultAgent = prefs.defaultAgent ?? "";
      autoNameModel = prefs.autoName?.model ?? "";
      autoNameSystemPrompt = prefs.autoName?.systemPrompt ?? "";
    } catch (err) {
      prefsError = errorMessage(err);
    } finally {
      prefsLoading = false;
    }
  }

  function buildUpdateBody(agentsOverride?: Record<string, { label: string; startCommand: string; resumeCommand?: string }>): UpdateUserPreferencesRequest {
    const body: UpdateUserPreferencesRequest = {};
    const trimmedDefault = defaultAgent.trim();
    if (trimmedDefault) body.defaultAgent = trimmedDefault;
    const agents = agentsOverride ?? prefs?.agents;
    if (agents && Object.keys(agents).length > 0) {
      body.agents = agents;
    }
    const trimmedModel = autoNameModel.trim();
    const trimmedPrompt = autoNameSystemPrompt.trim();
    if (trimmedModel || trimmedPrompt) {
      body.autoName = {};
      if (trimmedModel) body.autoName.model = trimmedModel;
      if (trimmedPrompt) body.autoName.systemPrompt = trimmedPrompt;
    }
    return body;
  }

  async function savePrefs(): Promise<void> {
    prefsSaving = true;
    prefsError = null;
    try {
      prefs = await updatePreferences(buildUpdateBody());
      syncAgentSummaries();
    } catch (err) {
      prefsError = errorMessage(err);
    } finally {
      prefsSaving = false;
    }
  }

  function syncAgentSummaries(): void {
    api.fetchConfig({ query: { projectId } })
      .then((config) => {
        onagentschange(config.agents);
      })
      .catch(() => {});
  }

  function handleAutoCreateToggle(enabled: boolean): void {
    pendingAutoCreate = enabled;
    autoCreateSaving = true;
    api.setLinearAutoCreate({ params: { projectId }, body: { enabled } })
      .then((result) => {
        onlinearautocreatechange(result.enabled);
      })
      .finally(() => {
        pendingAutoCreate = null;
        autoCreateSaving = false;
      });
  }

  function handleAutoRemoveToggle(enabled: boolean): void {
    pendingAutoRemove = enabled;
    autoRemoveSaving = true;
    api.setAutoRemoveOnMerge({ params: { projectId }, body: { enabled } })
      .then((result) => {
        onautoremovechange(result.enabled);
      })
      .finally(() => {
        pendingAutoRemove = null;
        autoRemoveSaving = false;
      });
  }

  function handleGlobalSave(): void {
    const trimmed = sshHost.trim();
    if (trimmed) {
      localStorage.setItem(SSH_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(SSH_STORAGE_KEY);
    }
    onsave(trimmed);
    void savePrefs();
  }


  function selectTheme(key: ThemeKey): void {
    applyTheme(key);
    onthemechange(key);
  }

  function openCreateAgentEditor(): void {
    editor = {
      mode: "create",
      title: "Add custom agent",
      initialValue: { label: "", startCommand: "", resumeCommand: "" },
    };
  }

  function openEditAgentEditor(id: string, agent: { label: string; startCommand: string; resumeCommand?: string }): void {
    editor = {
      mode: "edit",
      agentId: id,
      title: `Edit ${agent.label}`,
      initialValue: {
        label: agent.label,
        startCommand: agent.startCommand,
        resumeCommand: agent.resumeCommand ?? "",
      },
    };
  }

  function openDuplicateAgentEditor(agent: { label: string; startCommand: string; resumeCommand?: string }): void {
    editor = {
      mode: "create",
      title: `Duplicate ${agent.label}`,
      initialValue: {
        label: `${agent.label} Copy`,
        startCommand: agent.startCommand,
        resumeCommand: agent.resumeCommand ?? "",
      },
    };
  }

  function normalizeAgentId(label: string): string {
    const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "agent";
  }

  async function handleSaveAgent(input: { label: string; startCommand: string; resumeCommand?: string }): Promise<void> {
    if (!editor || !prefs) return;

    const agentId = editor.mode === "edit" && editor.agentId
      ? editor.agentId
      : normalizeAgentId(input.label);

    const updatedAgents = {
      ...(prefs.agents ?? {}),
      [agentId]: {
        label: input.label,
        startCommand: input.startCommand,
        ...(input.resumeCommand?.trim() ? { resumeCommand: input.resumeCommand.trim() } : {}),
      },
    };

    prefsError = null;
    try {
      prefs = await updatePreferences(buildUpdateBody(updatedAgents));
      syncAgentSummaries();
      editor = null;
    } catch (err) {
      prefsError = errorMessage(err);
      throw err;
    }
  }

  async function handleDeleteAgent(): Promise<void> {
    if (!deleteCandidate || !prefs) return;
    deletingAgentId = deleteCandidate.id;
    prefsError = null;

    try {
      const updatedAgents = { ...(prefs.agents ?? {}) };
      delete updatedAgents[deleteCandidate.id];
      prefs = await updatePreferences(buildUpdateBody(updatedAgents));
      syncAgentSummaries();
      deleteCandidate = null;
    } catch (err) {
      prefsError = errorMessage(err);
    } finally {
      deletingAgentId = null;
    }
  }
</script>

<BaseDialog {onclose} wide>
  <h2 class="text-base mb-4">Settings</h2>

  <!-- Tab strip -->
  <div role="tablist" class="flex gap-1 border-b border-edge mb-4">
    <button
      type="button"
      role="tab"
      aria-selected={tab === "global"}
      class="px-3 py-1.5 text-[13px] rounded-t-md border-b-2 -mb-px transition-colors {tab === 'global'
        ? 'border-accent text-primary'
        : 'border-transparent text-muted hover:text-primary'}"
      onclick={() => (tab = "global")}
    >
      Global
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={tab === "project"}
      class="px-3 py-1.5 text-[13px] rounded-t-md border-b-2 -mb-px transition-colors {tab === 'project'
        ? 'border-accent text-primary'
        : 'border-transparent text-muted hover:text-primary'}"
      onclick={() => (tab = "project")}
    >
      Project
    </button>
  </div>

  {#if tab === "global"}
    <form onsubmit={(event) => { event.preventDefault(); handleGlobalSave(); }}>
      <!-- Theme -->
      <div class="mb-5">
        <span class="block text-xs text-muted mb-2">Theme</span>
        <div class="grid grid-cols-2 gap-2">
          {#each THEMES as theme (theme.key)}
            <button
              type="button"
              class="flex items-center gap-2.5 px-3 py-2 rounded-md border cursor-pointer text-left text-[13px] transition-colors {currentTheme === theme.key
                ? 'border-accent bg-active text-primary'
                : 'border-edge bg-surface text-muted hover:bg-hover hover:text-primary'}"
              onclick={() => selectTheme(theme.key)}
            >
              <span class="shrink-0 flex gap-0.5">
                {#each [theme.colors.surface, theme.colors.accent, theme.colors.success, theme.colors.warning] as color}
                  <span class="w-3 h-3 rounded-full border border-edge" style="background:{color}"></span>
                {/each}
              </span>
              <span>{theme.label}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- Global prefs loading state -->
      {#if prefsLoading}
        <p class="text-[12px] text-muted mb-5">Loading preferences...</p>
      {:else if prefsError}
        <p class="text-[12px] text-danger mb-5">{prefsError}</p>
      {:else}
        <!-- Default agent -->
        <div class="mb-5">
          <label class="block text-xs text-muted mb-1.5" for="default-agent">Default agent</label>
          <select
            id="default-agent"
            class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
            bind:value={defaultAgent}
            disabled={prefsSaving}
          >
            <option value="">— inherit from project —</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            {#each customAgentEntries as [id, agent] (id)}
              <option value={id}>{agent.label}</option>
            {/each}
          </select>
        </div>

        <!-- Auto-name -->
        <div class="mb-5">
          <span class="block text-xs text-muted mb-2">Auto-name</span>
          <div class="space-y-3">
            <div>
              <label class="block text-[11px] text-muted mb-1" for="autoname-model">Model</label>
              <input
                id="autoname-model"
                type="text"
                class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
                placeholder="e.g. claude-haiku-3-5"
                bind:value={autoNameModel}
                disabled={prefsSaving}
              />
            </div>
            <div>
              <label class="block text-[11px] text-muted mb-1" for="autoname-prompt">System prompt</label>
              <textarea
                id="autoname-prompt"
                rows="3"
                class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent resize-y"
                placeholder="Optional system prompt for branch name generation"
                bind:value={autoNameSystemPrompt}
                disabled={prefsSaving}
              ></textarea>
            </div>
          </div>
        </div>

        <!-- Custom agents -->
        <div class="mb-5">
          <span class="block text-xs text-muted mb-2">Agents</span>
          <div class="rounded-lg border border-edge bg-surface/40 p-3">
            <div class="mb-3 flex items-center justify-between gap-2">
              <div>
                <p class="text-[13px] text-primary">Custom agents</p>
                <p class="mt-0.5 text-[11px] text-muted">
                  Add terminal agents available across all projects.
                </p>
              </div>
              <Btn type="button" variant="cta" onclick={openCreateAgentEditor}>Add agent</Btn>
            </div>

            {#if customAgentEntries.length === 0}
              <p class="text-[12px] text-muted">No custom agents setup</p>
            {:else}
              <div class="space-y-2">
                {#each customAgentEntries as [id, agent] (id)}
                  <div class="rounded-lg border border-edge bg-surface px-3 py-2.5">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="text-[13px] text-primary">{agent.label}</span>
                        </div>
                        <p class="mt-1 text-[11px] text-muted font-mono break-all">
                          {agent.startCommand}
                        </p>
                        {#if agent.resumeCommand}
                          <p class="mt-1 text-[11px] text-muted font-mono break-all">
                            Resume: {agent.resumeCommand}
                          </p>
                        {/if}
                      </div>
                      <div class="flex shrink-0 gap-2 text-[11px]">
                        <button type="button" class="text-accent hover:underline" onclick={() => openEditAgentEditor(id, agent)}>
                          Edit
                        </button>
                        <button type="button" class="text-accent hover:underline" onclick={() => openDuplicateAgentEditor(agent)}>
                          Duplicate
                        </button>
                        <button
                          type="button"
                          class="text-danger hover:underline disabled:opacity-60"
                          disabled={deletingAgentId === id}
                          onclick={() => (deleteCandidate = { id, label: agent.label })}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- SSH host -->
      <div class="mb-4">
        <label class="block text-xs text-muted mb-1.5" for="ssh-host">
          SSH Host <span class="opacity-60">(for "Open in Cursor")</span>
        </label>
        <input
          id="ssh-host"
          type="text"
          class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
          placeholder="e.g. devbox or 10.0.0.5"
          bind:value={sshHost}
        />
        <p class="text-[11px] text-muted mt-1.5">
          Must match an entry in your local <code class="text-accent/80">~/.ssh/config</code>. Leave empty for local mode.
        </p>
      </div>

      <div class="flex justify-end gap-2">
        <Btn type="button" onclick={onclose}>Cancel</Btn>
        <Btn type="submit" variant="cta" disabled={prefsSaving}>
          {prefsSaving ? "Saving..." : "Save"}
        </Btn>
      </div>
    </form>
  {:else}
    <div>
      <div class="mb-5">
        <span class="block text-xs text-muted mb-2">Linear</span>
        <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
          <div>
            <span class="text-[13px] text-primary">Auto-create worktrees</span>
            <p class="text-[11px] text-muted mt-0.5">
              Automatically create worktrees for Todo Linear tickets with the "webmux" label.
            </p>
          </div>
          <Toggle
            checked={autoCreate}
            disabled={autoCreateSaving}
            ontoggle={handleAutoCreateToggle}
            aria-label="Auto-create worktrees for Linear tickets"
          />
        </div>
      </div>

      <div class="mb-5">
        <span class="block text-xs text-muted mb-2">GitHub</span>
        <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
          <div>
            <span class="text-[13px] text-primary">Auto-remove on merge</span>
            <p class="text-[11px] text-muted mt-0.5">
              Automatically remove worktrees when their PR is merged on GitHub.
            </p>
          </div>
          <Toggle
            checked={autoRemove}
            disabled={autoRemoveSaving}
            ontoggle={handleAutoRemoveToggle}
            aria-label="Auto-remove worktrees on PR merge"
          />
        </div>
      </div>

      <p class="text-[11px] text-muted">
        Linear and GitHub toggles save automatically. There's nothing else to save here.
      </p>

      <div class="flex justify-end gap-2 mt-5">
        <Btn type="button" onclick={onclose}>Close</Btn>
      </div>
    </div>
  {/if}
</BaseDialog>

{#if editor}
  <AgentEditorDialog
    title={editor.title}
    initialValue={editor.initialValue}
    onsave={handleSaveAgent}
    onclose={() => (editor = null)}
  />
{/if}

{#if deleteCandidate}
  <ConfirmDialog
    message={`Delete agent "${deleteCandidate.label}"?`}
    onconfirm={() => { void handleDeleteAgent(); }}
    oncancel={() => { deleteCandidate = null; }}
  />
{/if}
