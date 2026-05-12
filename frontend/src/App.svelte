<script lang="ts">
  import { onMount, type Component } from "svelte";
  import ProjectTree from "./lib/ProjectTree.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import Terminal from "./lib/Terminal.svelte";
  import ConfirmDialog from "./lib/ConfirmDialog.svelte";
  import CreateWorktreeDialog from "./lib/CreateWorktreeDialog.svelte";
  import EditWorktreeDialog from "./lib/EditWorktreeDialog.svelte";
  import SettingsDialog from "./lib/SettingsDialog.svelte";
  import CiDetailsDialog from "./lib/CiDetailsDialog.svelte";
  import CommentReviewDialog from "./lib/CommentReviewDialog.svelte";
  import PaneBar from "./lib/PaneBar.svelte";
  import ToastStack from "./lib/ToastStack.svelte";
  import LinearPanel from "./lib/LinearPanel.svelte";
  import LinearDetailDialog from "./lib/LinearDetailDialog.svelte";
  import MobileChatSurface from "./lib/MobileChatSurface.svelte";
  import SidebarRepoRow from "./lib/SidebarRepoRow.svelte";
  import Toggle from "./lib/Toggle.svelte";
  import CreateScratchDialog from "./lib/CreateScratchDialog.svelte";
  import AddProjectDialog from "./lib/AddProjectDialog.svelte";
  import NewMenu from "./lib/NewMenu.svelte";
  import ConfirmRemoveProjectDialog from "./lib/ConfirmRemoveProjectDialog.svelte";
  import type {
    AvailableBranch,
    AppConfig,
    AppNotification,
    CreateWorktreeRequest,
    DiffDialogProps,
    ExternalTmuxSession,
    PrEntry,
    LinearIssueAvailability,
    LinearIssue,
    ProjectInfo,
    ScratchSessionSnapshot,
    Selection,
    ToastInput,
    ToastItem,
    UiToastItem,
    WorktreeInfo,
  } from "./lib/types";
  import {
    SSH_STORAGE_KEY,
    makeCursorUrl,
    errorMessage,
    worktreeCreationPhaseLabel,
    loadSavedTheme,
    loadSavedSelectedWorktree,
    saveSelectedWorktree,
    resolveSelectedBranch,
    applyTheme,
    loadSavedSidebarWidth,
    saveSidebarWidth,
  } from "./lib/utils";
  import {
    buildWorktreeListRows,
    countArchivedMatches,
    filterWorktrees,
    matchesWorktreeSearch,
  } from "./lib/worktree-list";
  import { getTheme } from "./lib/themes";
  import type { ThemeKey } from "./lib/themes";
  import { setToastController } from "./lib/toast-context";
  import {
    api,
    fetchWorktrees,
    fetchProjects,
    subscribeNotifications,
    fetchExternalSessions,
    fetchScratchSessions,
    createScratchSession,
    removeScratchSession,
    createProject,
    removeProject,
    openWorktree,
    updateWorktree,
  } from "./lib/api";
  import type { CreateProjectRequest } from "@webmux/api-contract";

  function createDefaultConfig(): AppConfig {
    return {
      name: "",
      services: [],
      profiles: [],
      agents: [],
      defaultProfileName: "",
      defaultAgentId: "claude",
      autoName: false,
      linearCreateTicketOption: false,
      startupEnvs: {},
      linkedRepos: [],
      linearAutoCreateWorktrees: false,
      autoRemoveOnMerge: false,
      projectDir: "",
      mainBranch: "",
    };
  }

  function supportsWorktreeChat(worktree: WorktreeInfo | undefined): boolean {
    if (!worktree?.agentName) return false;
    const agent = config.agents.find((candidate) => candidate.id === worktree.agentName);
    return agent?.capabilities.inAppChat ?? (worktree.agentName === "codex" || worktree.agentName === "claude");
  }

  function supportsSessionChat(sel: Selection | null): boolean {
    if (!sel) return false;
    if (sel.kind === "worktree") {
      return canConnect && supportsWorktreeChat(selectedWorktree);
    }
    if (sel.kind === "scratch") {
      const sessions = scratchByProject.get(sel.projectId) ?? [];
      const session = sessions.find((s) => s.id === sel.id);
      if (!session?.agentId) return false;
      const agent = config.agents.find((candidate) => candidate.id === session.agentId);
      return agent?.capabilities.inAppChat ?? (session.agentId === "claude" || session.agentId === "codex");
    }
    return false;
  }

  let config = $state<AppConfig>(createDefaultConfig());
  let projects = $state<ProjectInfo[]>([]);
  let currentProjectId = $state<string | null>(null);
  let worktreesByProject = $state<Map<string, WorktreeInfo[]>>(new Map());
  let scratchByProject = $state<Map<string, ScratchSessionSnapshot[]>>(new Map());
  let selectedBranch = $state<string | null>(loadSavedSelectedWorktree());
  let selectedExternalSession = $state<string | null>(null);
  let selectedScratchSession = $state<{ id: string; sessionName: string } | null>(null);
  let externalSessions = $state<ExternalTmuxSession[]>([]);
  let showCreateScratchDialog = $state(false);
  let showCreateAISessionDialog = $state(false);
  let hasLoadedWorktrees = $state(false);
  let removeBranch = $state<string | null>(null);
  let editWorktreeBranch = $state<string | null>(null);
  let scratchToRemove = $state<{ id: string; displayName: string } | null>(null);
  let mergeBranch = $state<string | null>(null);
  let removingBranches = $state<Set<string>>(new Set());
  let showCreateDialog = $state(false);
  let showSettingsDialog = $state(false);
  let showAddProjectDialog = $state(false);
  let projectToRemove = $state<{ id: string; name: string } | null>(null);
  let ciDetailsPr = $state<PrEntry | null>(null);
  let commentReviewPr = $state<PrEntry | null>(null);
  let showDiffDialog = $state(false);
  let DiffDialogComponent = $state<Component<DiffDialogProps> | null>(null);
  let pullMainConfirm = $state(false);
  let pullMainLoading = $state(false);
  let pullMainError = $state("");
  let pullMainForce = $state(false);
  let pullLinkedRepoAlias = $state<string | null>(null);
  let pullLinkedRepoLoading = $state(false);
  let pullLinkedRepoError = $state("");
  let pullLinkedRepoForce = $state(false);
  let pendingCreateCount = $state(0);
  let latestAutoSelectCreateId = -1;
  let nextCreateRequestId = 0;
  let nextAvailableBranchFetchId = 0;
  let nextBaseBranchFetchId = 0;
  let sshHost = $state(localStorage.getItem(SSH_STORAGE_KEY) ?? "");
  let currentTheme = $state<ThemeKey>(loadSavedTheme());
  let terminalTheme = $derived(getTheme(currentTheme).terminal);
  let applyPollInterval: ((intervalMs: number) => void) | null = null;
  let pendingCreateBranchHint = $state<string | null>(null);
  let availableBranches = $state<AvailableBranch[]>([]);
  let availableBranchesLoading = $state(false);
  let availableBranchesError = $state<string | null>(null);
  let baseBranches = $state<AvailableBranch[]>([]);
  let baseBranchesLoading = $state(false);
  let baseBranchesError = $state<string | null>(null);
  let includeRemoteBranches = $state(false);
  let searchQuery = $state("");
  let worktreeSearchInput = $state<HTMLInputElement | null>(null);
  let showArchivedWorktrees = $state(false);
  type BranchCacheKey = "local" | "remote";
  let availableBranchCache: Partial<Record<BranchCacheKey, AvailableBranch[]>> = {};
  let availableBranchRequests: Partial<Record<BranchCacheKey, Promise<AvailableBranch[]>>> = {};
  let baseBranchCache: AvailableBranch[] | null = null;
  let baseBranchRequest: Promise<AvailableBranch[]> | null = null;
  let diffDialogLoad: Promise<void> | null = null;

  // Linear integration
  let linearIssues = $state<LinearIssue[]>([]);
  let linearAvailability = $state<LinearIssueAvailability>("disabled");
  let assignIssue = $state<LinearIssue | null>(null);
  let detailIssue = $state<LinearIssue | null>(null);
  let linearLastFetch = 0;
  const LINEAR_THROTTLE_MS = 300_000;
  const DEFAULT_POLL_INTERVAL_MS = 5000;
  const ACTIVE_CREATE_POLL_INTERVAL_MS = 1000;

  // Notifications
  let notifications = $state<AppNotification[]>([]);
  let uiToasts = $state<UiToastItem[]>([]);
  let notificationHistory = $state<AppNotification[]>([]);
  let unreadCount = $state(0);
  const AUTO_DISMISS_MS = 4000;
  const MAX_HISTORY = 10;
  let nextToastId = 0;

  let notifiedBranches = $state<Set<string>>(new Set());
  let toasts = $derived([
    ...notifications.map((notification): ToastItem => ({
      id: `notification:${notification.id}`,
      source: "notification",
      notificationId: notification.id,
      tone: notification.type === "runtime_error"
        ? "error"
        : notification.type === "agent_stopped" || notification.type === "worktree_auto_removed"
          ? "success"
          : "info",
      message: notification.message,
      ...(notification.url ? { detail: notification.url } : {}),
      branch: notification.branch,
    })),
    ...uiToasts,
  ]);

  function getAvailableBranchCacheKey(includeRemote: boolean): BranchCacheKey {
    return includeRemote ? "remote" : "local";
  }

  function fetchAvailableBranchesCached(projectId: string, includeRemote: boolean): Promise<AvailableBranch[]> {
    const key = getAvailableBranchCacheKey(includeRemote);
    const cached = availableBranchCache[key];
    if (cached) return Promise.resolve(cached);

    const inFlight = availableBranchRequests[key];
    if (inFlight) return inFlight;

    const request = api.fetchAvailableBranches({ params: { projectId }, query: { includeRemote } })
      .then((data) => {
        availableBranchCache[key] = data.branches;
        return data.branches;
      })
      .finally(() => {
        delete availableBranchRequests[key];
      });

    availableBranchRequests[key] = request;
    return request;
  }

  function fetchBaseBranchesCached(projectId: string): Promise<AvailableBranch[]> {
    if (baseBranchCache) return Promise.resolve(baseBranchCache);
    if (baseBranchRequest) return baseBranchRequest;

    baseBranchRequest = api.fetchBaseBranches({ params: { projectId } })
      .then((data) => {
        baseBranchCache = data.branches;
        return data.branches;
      })
      .finally(() => {
        baseBranchRequest = null;
      });

    return baseBranchRequest;
  }

  function invalidateBranchCaches(): void {
    availableBranchCache = {};
    availableBranchRequests = {};
    baseBranchCache = null;
    baseBranchRequest = null;
    availableBranches = [];
    availableBranchesError = null;
    availableBranchesLoading = false;
    baseBranches = [];
    baseBranchesError = null;
    baseBranchesLoading = false;
  }

  function handleNotification(n: AppNotification): void {
    notifications = [...notifications, n];
    notifiedBranches = new Set([...notifiedBranches, n.branch]);
    notificationHistory = [n, ...notificationHistory].slice(0, MAX_HISTORY);
    unreadCount++;
    // Auto-dismiss after timeout
    setTimeout(() => {
      notifications = notifications.filter((x) => x.id !== n.id);
    }, AUTO_DISMISS_MS);
    // Browser notification when tab is hidden
    if (document.hidden && Notification.permission === "granted") {
      new Notification(n.message, { body: n.url ?? n.branch, tag: `wm-${n.id}` });
    }
  }

  function showToast(toast: ToastInput): void {
    const id = `ui:${nextToastId++}`;
    uiToasts = [...uiToasts, { id, source: "ui", ...toast }];
    setTimeout(() => {
      uiToasts = uiToasts.filter((item) => item.id !== id);
    }, AUTO_DISMISS_MS);
  }

  function ensureDiffDialogLoaded(): Promise<void> {
    if (DiffDialogComponent) return Promise.resolve();
    if (diffDialogLoad) return diffDialogLoad;

    diffDialogLoad = import("./lib/DiffDialog.svelte")
      .then(({ default: component }) => {
        DiffDialogComponent = component;
      })
      .finally(() => {
        diffDialogLoad = null;
      });

    return diffDialogLoad;
  }

  async function openDiffDialog(): Promise<void> {
    try {
      await ensureDiffDialogLoaded();
      showDiffDialog = true;
    } catch (err: unknown) {
      showToast({
        tone: "error",
        message: "Failed to load changes view.",
        detail: errorMessage(err),
      });
    }
  }

  function handleInitialNotification(n: AppNotification): void {
    if (notificationHistory.some((x) => x.id === n.id)) return;
    notificationHistory = [n, ...notificationHistory].slice(0, MAX_HISTORY);
  }

  function handleDismissNotification(id: number): void {
    notifications = notifications.filter((n) => n.id !== id);
    if (currentProjectId) {
      api.dismissNotification({ params: { projectId: currentProjectId, id } }).catch(() => {});
    }
  }

  function handleSseDismiss(id: number): void {
    notifications = notifications.filter((n) => n.id !== id);
  }

  function handleDismissToast(id: string): void {
    const toast = toasts.find((item) => item.id === id);
    if (!toast) return;

    if (toast.source === "notification") {
      handleDismissNotification(toast.notificationId);
      return;
    }

    uiToasts = uiToasts.filter((item) => item.id !== id);
  }

  function handleSelectToast(id: string): void {
    const toast = toasts.find((item) => item.id === id);
    if (!toast || toast.source !== "notification") return;

    handleDismissToast(id);
    selectedBranch = toast.branch;
    selectedExternalSession = null;
    selectedScratchSession = null;
    notifiedBranches = new Set([...notifiedBranches].filter((branch) => branch !== toast.branch));
    if (isMobile) sidebarOpen = false;
  }

  setToastController({
    show: showToast,
    info: (message, detail) => showToast({ tone: "info", message, ...(detail ? { detail } : {}) }),
    success: (message, detail) => showToast({ tone: "success", message, ...(detail ? { detail } : {}) }),
    error: (message, detail) => showToast({ tone: "error", message, ...(detail ? { detail } : {}) }),
  });

  function handleBellOpen(): void {
    unreadCount = 0;
  }

  // Sidebar resize
  const MIN_SIDEBAR_WIDTH = 140;
  const MAX_SIDEBAR_WIDTH = 500;
  const SIDEBAR_KEYBOARD_STEP = 10;
  let sidebarWidth = $state(
    Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, loadSavedSidebarWidth())),
  );
  let isResizingSidebar = $state(false);

  function clampSidebarWidth(w: number): number {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w));
  }

  function handleResizeStart(e: PointerEvent) {
    e.preventDefault();
    isResizingSidebar = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    function onPointerMove(ev: PointerEvent) {
      sidebarWidth = clampSidebarWidth(startWidth + ev.clientX - startX);
    }

    function onPointerUp() {
      isResizingSidebar = false;
      saveSidebarWidth(sidebarWidth);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function handleResizeKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? SIDEBAR_KEYBOARD_STEP : -SIDEBAR_KEYBOARD_STEP;
      sidebarWidth = clampSidebarWidth(sidebarWidth + delta);
      saveSidebarWidth(sidebarWidth);
    }
  }

  // Mobile state
  let isMobile = $state(false);
  let sidebarOpen = $state(false);
  let activePane = $state(0);
  let terminalRef:
    | {
        sendSelectPane: (pane: number) => void;
        sendInput: (data: string) => void;
      }
    | undefined = $state();

  // Safety buffer after backend confirms paste-buffer completion.
  // paste-buffer exits once tmux has queued the data, but the PTY write
  // may not be fully flushed yet — this small delay lets it settle.
  const ENTER_DELAY_MS = 200;

  let openingBranches = $state<Set<string>>(new Set());
  let archivingBranches = $state<Set<string>>(new Set());
  let openWithMenuOpen = $state(false);
  let openWithMenuTop = $state(0);
  let openWithMenuLeft = $state(0);
  let openWithCaretEl = $state<HTMLButtonElement | null>(null);
  let trimmedWorktreeSearch = $derived(searchQuery.trim());
  // Current project's worktree list (flat, for single-project operations)
  let currentWorktrees = $derived(currentProjectId ? (worktreesByProject.get(currentProjectId) ?? []) : []);
  // Per-project rows (filtered + built) for the tree
  let rowsByProject = $derived(
    new Map(
      [...worktreesByProject].map(([id, ws]) => [
        id,
        buildWorktreeListRows(
          filterWorktrees(ws, { query: id === currentProjectId ? trimmedWorktreeSearch : "", showArchived: id === currentProjectId ? showArchivedWorktrees : false }),
        ),
      ]),
    ),
  );
  let archivedWorktreeCount = $derived(currentWorktrees.filter((w) => w.archived).length);
  let hiddenArchivedMatchCount = $derived(
    showArchivedWorktrees ? 0 : countArchivedMatches(currentWorktrees, trimmedWorktreeSearch),
  );
  let visibleWorktrees = $derived(
    filterWorktrees(currentWorktrees, {
      query: trimmedWorktreeSearch,
      showArchived: showArchivedWorktrees,
    }),
  );
  let visibleWorktreeRows = $derived(buildWorktreeListRows(visibleWorktrees));
  let creatingWorktrees = $derived(currentWorktrees.filter((w) => w.creating));
  let backendCreatingCount = $derived(creatingWorktrees.length);
  let activeCreateCount = $derived(Math.max(pendingCreateCount, backendCreatingCount));
  let hasCreatingWorktrees = $derived(activeCreateCount > 0);
  let selectableWorktrees = $derived(
    visibleWorktrees.filter((w) => !removingBranches.has(w.branch)),
  );
  let createIndicatorLabel = $derived(
    activeCreateCount === 1 ? "Creating..." : `Creating ${activeCreateCount}...`,
  );
  let selectedVisibleWorktree = $derived(
    selectedBranch && !removingBranches.has(selectedBranch)
      ? visibleWorktrees.find((w) => w.branch === selectedBranch)
      : undefined,
  );
  let selectedWorktree = $derived(
    currentProjectId && selectedBranch && !removingBranches.has(selectedBranch)
      ? worktreesByProject.get(currentProjectId)?.find((w) => w.branch === selectedBranch)
      : undefined,
  );
  let selection = $derived<Selection | null>(
    currentProjectId === null
      ? null
      : selectedScratchSession
        ? { kind: "scratch", projectId: currentProjectId, id: selectedScratchSession.id, sessionName: selectedScratchSession.sessionName }
        : selectedExternalSession
          ? { kind: "external", sessionName: selectedExternalSession }
          : selectedBranch
            ? { kind: "worktree", projectId: currentProjectId, branch: selectedBranch }
            : null
  );
  let canConnect = $derived(!!selectedBranch && selectedWorktree?.mux === "✓" && !selectedWorktree?.creating);
  let mobileViewOverride = $state<"auto" | "terminal" | "chat">(
    ((): "auto" | "terminal" | "chat" => {
      const saved = localStorage.getItem("webmux.viewOverride");
      return saved === "terminal" || saved === "chat" ? saved : "auto";
    })(),
  );
  let showMobileChat = $derived(
    mobileViewOverride === "terminal"
      ? false
      : mobileViewOverride === "chat"
        ? supportsSessionChat(selection)
        : isMobile && supportsSessionChat(selection),
  );
  let showViewToggle = $derived(supportsSessionChat(selection));
  let isSelectedOpening = $derived(selectedBranch ? openingBranches.has(selectedBranch) : false);
  let isSelectedArchiving = $derived(selectedBranch ? archivingBranches.has(selectedBranch) : false);
  let pollIntervalMs = $derived(
    hasCreatingWorktrees ? ACTIVE_CREATE_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS,
  );
  let showLinearPanel = $derived(linearAvailability !== "disabled");
  let worktreeListEmptyMessage = $derived(
    trimmedWorktreeSearch
      ? hiddenArchivedMatchCount > 0
        ? "Archived matches are hidden."
        : `No matches for "${trimmedWorktreeSearch}".`
      : archivedWorktreeCount > 0 && !showArchivedWorktrees
        ? "No active worktrees."
        : "No worktrees found.",
  );

  $effect(() => {
    // Don't auto-select a worktree while a non-worktree session is active
    if (selectedExternalSession || selectedScratchSession) return;
    const nextSelectedBranch = resolveSelectedBranch(
      selectedBranch,
      trimmedWorktreeSearch ? selectedWorktree : selectedVisibleWorktree,
      selectableWorktrees,
      hasLoadedWorktrees,
    );
    if (nextSelectedBranch !== selectedBranch) {
      selectedBranch = nextSelectedBranch;
    }
  });

  $effect(() => {
    const id = currentProjectId;
    if (!id) return;
    api.fetchConfig({ query: { projectId: id } })
      .then((c) => {
        config = c;
      })
      .catch(() => {});
  });

  $effect(() => {
    if (pendingCreateCount === 0 || latestAutoSelectCreateId === -1) return;
    const target = pendingCreateBranchHint
      ? currentWorktrees.find((w) => w.branch === pendingCreateBranchHint)
      : creatingWorktrees.length === 1
        ? creatingWorktrees[0]
        : undefined;
    if (!target) return;
    revealWorktreeInFilters(target.branch);
    selectedBranch = target.branch;
    selectedExternalSession = null;
    selectedScratchSession = null;
    if (isMobile) sidebarOpen = false;
  });

  $effect(() => {
    applyPollInterval?.(pollIntervalMs);
  });

  $effect(() => {
    if (!hasLoadedWorktrees) return;
    if (selectedWorktree) {
      saveSelectedWorktree(selectedWorktree.branch);
      return;
    }
    if (selectableWorktrees.length === 0) {
      saveSelectedWorktree(null);
    }
  });

  $effect(() => {
    if (!showCreateDialog || !currentProjectId) return;

    const cached = availableBranchCache[getAvailableBranchCacheKey(includeRemoteBranches)];
    if (cached) {
      availableBranches = cached;
      availableBranchesLoading = false;
      availableBranchesError = null;
      return;
    }

    const fetchId = ++nextAvailableBranchFetchId;
    availableBranchesLoading = true;
    availableBranchesError = null;

    fetchAvailableBranchesCached(currentProjectId, includeRemoteBranches)
      .then((branches) => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranches = branches;
      })
      .catch((err: unknown) => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranchesError = errorMessage(err);
      })
      .finally(() => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranchesLoading = false;
      });
  });

  $effect(() => {
    if (!showCreateDialog || !currentProjectId) return;

    if (baseBranchCache) {
      baseBranches = baseBranchCache;
      baseBranchesLoading = false;
      baseBranchesError = null;
      return;
    }

    const fetchId = ++nextBaseBranchFetchId;
    baseBranches = [];
    baseBranchesLoading = true;
    baseBranchesError = null;

    fetchBaseBranchesCached(currentProjectId)
      .then((branches) => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranches = branches;
      })
      .catch((err: unknown) => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranchesError = errorMessage(err);
      })
      .finally(() => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranchesLoading = false;
      });
  });

  $effect(() => {
    document.title = "webmux";
  });

  let paneBarPanes = $derived.by(() => {
    const count = selectedWorktree?.paneCount ?? 0;
    if (count < 2) return [];
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      label: String(i + 1),
    }));
  });
  let showPaneBar = $derived(isMobile && canConnect && !showMobileChat && paneBarPanes.length > 0);

  function refreshLinear(): void {
    if (!currentProjectId) return;
    const now = Date.now();
    if (now - linearLastFetch < LINEAR_THROTTLE_MS) return;
    linearLastFetch = now;
    api.fetchLinearIssues({ params: { projectId: currentProjectId } }).then((data) => {
      linearAvailability = data.availability;
      linearIssues = data.issues;
    }).catch((err: unknown) => console.warn("[linear]", err));
  }

  async function refreshAll(): Promise<void> {
    try {
      const list = await fetchProjects();
      projects = list;
      if (list.length > 0 && !currentProjectId) {
        currentProjectId = list[0].id;
      }

      const ids = list.map((p) => p.id);
      const [worktreesPairs, scratchPairs, ext] = await Promise.all([
        Promise.all(ids.map(async (id) => [id, await fetchWorktrees(id)] as const)),
        Promise.all(ids.map(async (id) => [id, await fetchScratchSessions(id)] as const)),
        fetchExternalSessions(),
      ]);
      worktreesByProject = new Map(worktreesPairs);
      scratchByProject = new Map(scratchPairs);
      externalSessions = ext;
      hasLoadedWorktrees = true;
    } catch (err) {
      console.warn("refreshAll failed", err);
    }
    refreshLinear();
  }

  async function refresh(): Promise<void> {
    await refreshAll();
  }

  function openCreateDialog(issue: LinearIssue | null = null): void {
    includeRemoteBranches = false;
    assignIssue = issue;
    showCreateDialog = true;
  }

  function handleAssignIssue(issue: LinearIssue): void {
    openCreateDialog(issue);
  }

  async function handleCreate(request: CreateWorktreeRequest) {
    const requestId = nextCreateRequestId++;
    const shouldAutoSelectCreatedWorktree = selectedWorktree == null;
    const requestedAgentIds = request.agents && request.agents.length > 0
      ? request.agents
      : request.agent
        ? [request.agent]
        : [config.defaultAgentId];
    const expectedCreatedCount = requestedAgentIds.length;
    if (shouldAutoSelectCreatedWorktree) {
      latestAutoSelectCreateId = requestId;
    }
    pendingCreateCount += expectedCreatedCount;
    if (shouldAutoSelectCreatedWorktree) {
      pendingCreateBranchHint = expectedCreatedCount > 1 ? null : request.branch ?? null;
    }

    try {
      const createPromise = api.createWorktree({ params: { projectId: currentProjectId! }, body: request });
      void refresh();
      const result = await createPromise;
      showCreateDialog = false;
      assignIssue = null;
      if (shouldAutoSelectCreatedWorktree) {
        pendingCreateBranchHint = result.primaryBranch;
      }
      invalidateBranchCaches();
      await refresh();
      if (request.createLinearTicket) {
        linearLastFetch = 0;
        refreshLinear();
      }
      if (shouldAutoSelectCreatedWorktree && requestId === latestAutoSelectCreateId) {
        selectedBranch = result.primaryBranch;
        if (isMobile) sidebarOpen = false;
      }
    } catch (err) {
      showToast({ tone: "error", message: `Failed to create: ${errorMessage(err)}` });
      throw err;
    } finally {
      pendingCreateCount = Math.max(0, pendingCreateCount - expectedCreatedCount);
      if (shouldAutoSelectCreatedWorktree && requestId === latestAutoSelectCreateId) {
        pendingCreateBranchHint = null;
        latestAutoSelectCreateId = -1;
      }
    }
  }

  function selectNeighborOf(branch: string) {
    if (selectedBranch !== branch) return;
    const orderedWorktrees = visibleWorktreeRows.map((row) => row.worktree);
    const idx = orderedWorktrees.findIndex((w) => w.branch === branch);
    const previous = orderedWorktrees[idx - 1];
    const next = orderedWorktrees[idx + 1];
    const neighbor = [previous, next].find((candidate) =>
      candidate
      && !removingBranches.has(candidate.branch)
    );
    selectedBranch = neighbor ? neighbor.branch : null;
  }

  function revealWorktreeInFilters(branch: string): void {
    const worktree = currentWorktrees.find((candidate) => candidate.branch === branch);
    if (!worktree) return;
    if (worktree.archived) {
      showArchivedWorktrees = true;
    }
    if (trimmedWorktreeSearch && !matchesWorktreeSearch(worktree, trimmedWorktreeSearch)) {
      searchQuery = "";
    }
  }

  function handleSelectWorktreeByBranch(branch: string): void {
    revealWorktreeInFilters(branch);
    selectedBranch = branch;
    selectedExternalSession = null;
    selectedScratchSession = null;
    notifiedBranches = new Set([...notifiedBranches].filter((candidate) => candidate !== branch));
    if (isMobile) sidebarOpen = false;
  }

  function handleSelectWorktree(projectId: string, branch: string): void {
    currentProjectId = projectId;
    revealWorktreeInFilters(branch);
    selectedBranch = branch;
    selectedExternalSession = null;
    selectedScratchSession = null;
    saveSelectedWorktree(branch);
    notifiedBranches = new Set([...notifiedBranches].filter((candidate) => candidate !== branch));
    if (isMobile) sidebarOpen = false;
  }

  async function handleRemove() {
    const branch = removeBranch;
    if (!branch) return;
    removeBranch = null;
    selectNeighborOf(branch);

    removingBranches = new Set([...removingBranches, branch]);
    try {
      await api.removeWorktree({ params: { projectId: currentProjectId!, name: branch } });
      invalidateBranchCaches();
      await refresh();
    } catch (err) {
      showToast({ tone: "error", message: `Failed to remove: ${errorMessage(err)}` });
    } finally {
      removingBranches = new Set(
        [...removingBranches].filter((b) => b !== branch),
      );
    }
  }

  async function handleMerge() {
    const branch = mergeBranch;
    if (!branch) return;
    mergeBranch = null;
    selectNeighborOf(branch);

    removingBranches = new Set([...removingBranches, branch]);
    try {
      await api.mergeWorktree({ params: { projectId: currentProjectId!, name: branch } });
      invalidateBranchCaches();
      await refresh();
    } catch (err) {
      showToast({ tone: "error", message: `Failed to merge: ${errorMessage(err)}` });
    } finally {
      removingBranches = new Set(
        [...removingBranches].filter((b) => b !== branch),
      );
    }
  }

  async function handlePullMain(): Promise<void> {
    pullMainLoading = true;
    pullMainError = "";
    try {
      const result = await api.pullMain({
        params: { projectId: currentProjectId! },
        body: { ...(pullMainForce ? { force: true } : {}) },
      });
      if (result.status === "updated" || result.status === "already_up_to_date") {
        pullMainConfirm = false;
        pullMainForce = false;
        showToast({
          tone: result.status === "updated" ? "success" : "info",
          message: result.status === "updated"
            ? `Pulled latest "${config.mainBranch ?? "main"}" from remote`
            : `"${config.mainBranch ?? "main"}" is already up to date`,
        });
      } else if (result.status === "merge_failed" && !pullMainForce) {
        pullMainForce = true;
        pullMainError = `Fast-forward failed: ${result.error ?? "unknown error"}.\nForce pull will reset main to match remote.`;
      } else {
        pullMainError = result.error ?? result.status;
      }
    } catch (err) {
      pullMainError = errorMessage(err);
    } finally {
      pullMainLoading = false;
    }
  }

  async function handlePullLinkedRepo(): Promise<void> {
    if (!pullLinkedRepoAlias) return;
    pullLinkedRepoLoading = true;
    pullLinkedRepoError = "";
    try {
      const result = await api.pullMain({
        params: { projectId: currentProjectId! },
        body: {
          ...(pullLinkedRepoForce ? { force: true } : {}),
          ...(pullLinkedRepoAlias ? { repo: pullLinkedRepoAlias } : {}),
        },
      });
      if (result.status === "updated" || result.status === "already_up_to_date") {
        pullLinkedRepoAlias = null;
        pullLinkedRepoForce = false;
      } else if (result.status === "merge_failed" && !pullLinkedRepoForce) {
        pullLinkedRepoForce = true;
        pullLinkedRepoError = `Fast-forward failed: ${result.error ?? "unknown error"}.\nForce pull will reset to match remote.`;
      } else {
        pullLinkedRepoError = result.error ?? result.status;
      }
    } catch (err) {
      pullLinkedRepoError = errorMessage(err);
    } finally {
      pullLinkedRepoLoading = false;
    }
  }

  async function openSelectedWorktree(): Promise<void> {
    const branch = selectedBranch;
    if (!branch) return;
    openingBranches = new Set([...openingBranches, branch]);
    try {
      await openWorktree(currentProjectId!, branch);
      await refresh();
    } catch (err) {
      showToast({ tone: "error", message: `Failed to open worktree: ${errorMessage(err)}` });
    } finally {
      openingBranches = new Set([...openingBranches].filter((x) => x !== branch));
    }
  }

  async function openSelectedWorktreeWith(opts: { agentOverride?: string; shellOnly?: boolean }): Promise<void> {
    const branch = selectedBranch;
    if (!branch) return;
    openWithMenuOpen = false;
    openingBranches = new Set([...openingBranches, branch]);
    try {
      await openWorktree(currentProjectId!, branch, opts);
      await refresh();
    } catch (err) {
      showToast({ tone: "error", message: `Failed to open worktree: ${errorMessage(err)}` });
    } finally {
      openingBranches = new Set([...openingBranches].filter((x) => x !== branch));
    }
  }

  function toggleOpenWithMenu(e: MouseEvent): void {
    e.stopPropagation();
    if (!openWithMenuOpen && openWithCaretEl) {
      const rect = openWithCaretEl.getBoundingClientRect();
      openWithMenuTop = rect.bottom + 4;
      openWithMenuLeft = rect.left + rect.width / 2;
    }
    openWithMenuOpen = !openWithMenuOpen;
  }

  $effect(() => {
    if (!openWithMenuOpen) return;
    function onClickOutside(): void { openWithMenuOpen = false; }
    function onScroll(): void { openWithMenuOpen = false; }
    function onResize(): void { openWithMenuOpen = false; }
    const timer = setTimeout(() => {
      window.addEventListener("click", onClickOutside, { once: true });
      document.addEventListener("scroll", onScroll, { capture: true, once: true });
      window.addEventListener("resize", onResize);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", onClickOutside);
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", onResize);
    };
  });

  async function toggleWorktreeArchived(branch: string): Promise<void> {
    const worktree = currentWorktrees.find((candidate) => candidate.branch === branch);
    if (!worktree || worktree.creating) return;
    const nextArchived = !worktree.archived;
    const actionLabel = nextArchived ? "archive" : "restore";

    archivingBranches = new Set([...archivingBranches, branch]);
    try {
      await api.setWorktreeArchived({
        params: { projectId: currentProjectId!, name: branch },
        body: { archived: nextArchived },
      });
      await refresh();
    } catch (err) {
      alert(`Failed to ${actionLabel} worktree: ${errorMessage(err)}`);
    } finally {
      archivingBranches = new Set([...archivingBranches].filter((candidate) => candidate !== branch));
    }
  }

  async function closeWorktree(branch: string): Promise<void> {
    selectNeighborOf(branch);
    try {
      await api.closeWorktree({ params: { projectId: currentProjectId!, name: branch } });
      await refresh();
    } catch (err) {
      showToast({ tone: "error", message: `Failed to close worktree: ${errorMessage(err)}` });
    }
  }

  async function handleSaveEditWorktree(branch: string, yolo: boolean, agent: string): Promise<void> {
    const projectId = currentProjectId!;
    await updateWorktree(projectId, branch, { yolo, agent });
    const worktree = currentWorktrees.find((w) => w.branch === branch);
    const wasSelected = selectedBranch === branch;
    if (worktree?.mux === "✓") {
      await api.closeWorktree({ params: { projectId, name: branch } });
      if (wasSelected) selectedBranch = null;
      await openWorktree(projectId, branch);
      if (wasSelected) selectedBranch = branch;
    }
    editWorktreeBranch = null;
    await refresh();
  }

  async function handleArchiveToggle() {
    const branch = selectedBranch;
    if (!branch) return;
    await toggleWorktreeArchived(branch);
  }

  async function handleClose() {
    const branch = selectedBranch;
    if (!branch) return;
    await closeWorktree(branch);
  }

  function selectNeighborWorktree(direction: -1 | 1) {
    const selectable = visibleWorktrees.filter(
      (w) => !removingBranches.has(w.branch),
    );
    if (selectable.length === 0) return;
    if (!selectedBranch) {
      selectedBranch =
        selectable[direction === 1 ? 0 : selectable.length - 1].branch;
      return;
    }
    const idx = selectable.findIndex((w) => w.branch === selectedBranch);
    const next = idx + direction;
    if (next >= 0 && next < selectable.length) {
      selectedBranch = selectable[next].branch;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && openWithMenuOpen) {
      e.stopPropagation();
      openWithMenuOpen = false;
      return;
    }

    // Ignore shortcuts when a dialog is open (let dialog handle its own keys)
    if (showCreateDialog || showCreateAISessionDialog || removeBranch || mergeBranch || pullMainConfirm || pullLinkedRepoAlias) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectNeighborWorktree(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectNeighborWorktree(1);
    } else if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      openCreateDialog();
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      if (selectedBranch) mergeBranch = selectedBranch;
    } else if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      if (selectedBranch) removeBranch = selectedBranch;
    } else if (e.key === "Enter") {
      if (selectedWorktree && selectedWorktree.mux !== "✓" && !selectedWorktree.creating && !isSelectedOpening) {
        e.preventDefault();
        openSelectedWorktree();
      }
    }
  }

  function handlePaneSelect(pane: number) {
    activePane = pane;
    terminalRef?.sendSelectPane(pane);
  }

  async function handleCreateScratch(req: import("@webmux/api-contract").CreateScratchSessionRequest) {
    const session = await createScratchSession(currentProjectId!, req);
    const existing = scratchByProject.get(currentProjectId!) ?? [];
    scratchByProject = new Map([...scratchByProject, [currentProjectId!, [...existing, session]]]);
    selectedExternalSession = null;
    selectedBranch = null;
    saveSelectedWorktree(null);
    selectedScratchSession = { id: session.id, sessionName: session.sessionName };
  }

  function handleRemoveScratch(id: string, displayName: string) {
    scratchToRemove = { id, displayName };
  }

  async function confirmRemoveScratch() {
    const target = scratchToRemove;
    if (!target) return;
    await removeScratchSession(currentProjectId!, target.id);
    const existing = scratchByProject.get(currentProjectId!) ?? [];
    scratchByProject = new Map([...scratchByProject, [currentProjectId!, existing.filter((s) => s.id !== target.id)]]);
    if (selectedScratchSession?.id === target.id) {
      selectedScratchSession = null;
    }
    scratchToRemove = null;
  }

  async function handleAddProject(req: CreateProjectRequest): Promise<void> {
    const project = await createProject(req);
    projects = [...projects, project];
    worktreesByProject = new Map([...worktreesByProject, [project.id, []]]);
    scratchByProject = new Map([...scratchByProject, [project.id, []]]);
    currentProjectId = project.id;
    selectedBranch = null;
    selectedScratchSession = null;
    selectedExternalSession = null;
    void refreshAll();
  }

  function handleMenuNewWorktree(projectId: string): void {
    currentProjectId = projectId;
    showCreateDialog = true;
  }

  function handleMenuSettings(projectId: string): void {
    currentProjectId = projectId;
    showSettingsDialog = true;
  }

  function handleMenuRemoveProject(projectId: string): void {
    const p = projects.find((x) => x.id === projectId);
    if (!p) return;
    projectToRemove = { id: p.id, name: p.name };
  }

  async function handleConfirmRemoveProject(killSessions: boolean): Promise<void> {
    if (!projectToRemove) return;
    const target = projectToRemove;
    try {
      await removeProject(target.id, killSessions);
    } catch (err) {
      console.error("removeProject failed", err);
    }
    projects = projects.filter((p) => p.id !== target.id);
    worktreesByProject = new Map([...worktreesByProject].filter(([id]) => id !== target.id));
    scratchByProject = new Map([...scratchByProject].filter(([id]) => id !== target.id));
    if (currentProjectId === target.id) {
      currentProjectId = projects[0]?.id ?? null;
      selectedBranch = null;
      selectedScratchSession = null;
    }
    projectToRemove = null;
  }

  function handleSelectExternal(name: string): void {
    selectedScratchSession = null;
    selectedBranch = null;
    saveSelectedWorktree(null);
    selectedExternalSession = name;
    if (isMobile) sidebarOpen = false;
  }

  function handleSelectScratch(projectId: string, id: string, sessionName: string): void {
    selectedExternalSession = null;
    selectedBranch = null;
    saveSelectedWorktree(null);
    currentProjectId = projectId;
    selectedScratchSession = { id, sessionName };
    if (isMobile) sidebarOpen = false;
  }

  onMount(() => {
    applyTheme(currentTheme);
    api
      .fetchConfig()
      .then((c) => {
        config = c;
      })
      .catch(() => {});
    void refreshAll();
    const sessionsPollHandle = setInterval(() => { void refreshAll(); }, 5000);
    let intervalMs = pollIntervalMs;
    let interval: ReturnType<typeof setInterval> | undefined;
    window.addEventListener("keydown", handleKeydown);
    let unsubNotifications = subscribeNotifications(handleNotification, handleSseDismiss, handleInitialNotification);
    // Request notification permission (no-op if already granted/denied)
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    // Pause polling when tab is hidden or idle (no interaction for 60s).
    let idleTimer: ReturnType<typeof setTimeout>;
    let idle = false;

    function startPolling(): void {
      if (interval) clearInterval(interval);
      if (document.hidden || idle) return;
      interval = setInterval(refresh, intervalMs);
    }

    applyPollInterval = (nextIntervalMs: number): void => {
      if (intervalMs === nextIntervalMs) return;
      intervalMs = nextIntervalMs;
      startPolling();
    };
    startPolling();

    function resetIdleTimer(): void {
      if (idle) {
        idle = false;
        refresh();
        startPolling();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        if (interval) clearInterval(interval);
      }, 60_000);
    }

    document.addEventListener("click", resetIdleTimer);
    document.addEventListener("keydown", resetIdleTimer);
    resetIdleTimer();

    function onVisibilityChange(): void {
      if (document.hidden) {
        if (interval) clearInterval(interval);
      } else {
        resetIdleTimer();
        refresh();
        startPolling();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    const mq = window.matchMedia("(max-width: 768px)");
    isMobile = mq.matches;
    if (isMobile) sidebarOpen = true;
    function onMqChange(e: MediaQueryListEvent): void {
      isMobile = e.matches;
    }
    mq.addEventListener("change", onMqChange);

    return () => {
      if (interval) clearInterval(interval);
      clearInterval(sessionsPollHandle);
      applyPollInterval = null;
      clearTimeout(idleTimer);
      document.removeEventListener("click", resetIdleTimer);
      document.removeEventListener("keydown", resetIdleTimer);
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      mq.removeEventListener("change", onMqChange);
      unsubNotifications();
    };
  });
</script>

<div class="flex h-dvh bg-surface text-primary {isResizingSidebar ? 'select-none' : ''}" style={isResizingSidebar ? 'cursor: col-resize' : ''}>
  <!-- Sidebar: fixed overlay on mobile, static on desktop -->
  {#if !isMobile || sidebarOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    {#if isMobile}
      <div
        class="fixed inset-0 bg-black/50 z-40"
        onclick={() => (sidebarOpen = false)}
        onkeydown={(e) => {
          if (e.key === "Escape") sidebarOpen = false;
        }}
      ></div>
    {/if}
    <aside
      class="{isMobile
        ? 'fixed inset-0 z-50 w-full'
        : ''} bg-sidebar border-r border-edge flex flex-col overflow-hidden shrink-0"
      style={isMobile ? '' : `width: ${sidebarWidth}px`}
    >
      <div class="p-4 border-b border-edge">
        <div class="flex items-center justify-between">
          <h1 class="text-base font-semibold">webmux</h1>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-primary text-xs flex items-center justify-center cursor-pointer hover:bg-hover"
              onclick={() => { showAddProjectDialog = true; }}
              title="Add an existing project to webmux"
            >
              <span class="text-lg leading-none">+</span> Project
            </button>
            <NewMenu
              onNewWorktree={() => openCreateDialog()}
              onNewAISession={() => { showCreateAISessionDialog = true; }}
            />
            {#if isMobile}
              <button
                class="h-8 w-8 rounded-md border border-edge bg-surface text-muted text-sm flex items-center justify-center cursor-pointer hover:bg-hover"
                onclick={() => (sidebarOpen = false)}
                title="Close sidebar">&times;</button
              >
            {/if}
          </div>
        </div>
        {#if activeCreateCount > 0}
          <div class="mt-2 flex items-center gap-1 text-[10px] text-muted">
            <span class="spinner"></span>
            {createIndicatorLabel}
          </div>
        {/if}
        <div class="mt-3 flex flex-col gap-2">
          <div class="relative">
            <input
              type="search"
              bind:this={worktreeSearchInput}
              bind:value={searchQuery}
              class="w-full h-7 rounded-md border border-edge bg-surface px-2 pr-6 text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent"
              placeholder="Search worktrees"
              aria-label="Search worktrees"
            />
            {#if trimmedWorktreeSearch}
              <button
                type="button"
                class="absolute top-1/2 right-1 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded text-muted hover:text-primary"
                onclick={() => {
                  searchQuery = "";
                  worktreeSearchInput?.focus();
                }}
                aria-label="Clear worktree search"
              >&times;</button>
            {/if}
          </div>
          <div class="flex items-center gap-2 text-[11px] text-muted">
            <label class="flex items-center gap-2 cursor-pointer">
              <Toggle
                checked={showArchivedWorktrees}
                size="sm"
                aria-label="Show archived worktrees"
                ontoggle={(checked) => {
                  showArchivedWorktrees = checked;
                }}
              />
              <span>Show archived{archivedWorktreeCount > 0 ? ` (${archivedWorktreeCount})` : ""}</span>
            </label>
          </div>
        </div>
      </div>
      <ProjectTree
        {projects}
        {rowsByProject}
        {scratchByProject}
        {externalSessions}
        {selection}
        selected={selectedBranch}
        removing={removingBranches}
        initializing={openingBranches}
        archiving={archivingBranches}
        {notifiedBranches}
        onSelectWorktree={handleSelectWorktree}
        onSelectScratch={handleSelectScratch}
        onSelectExternal={handleSelectExternal}
        onCreateScratch={(projectId) => { currentProjectId = projectId; showCreateScratchDialog = true; }}
        onRemoveScratch={(projectId, id, displayName) => { currentProjectId = projectId; scratchToRemove = { id, displayName }; }}
        onAddProject={() => { showAddProjectDialog = true; }}
        onMenuNewWorktree={handleMenuNewWorktree}
        onMenuSettings={handleMenuSettings}
        onMenuRemoveProject={handleMenuRemoveProject}
        onclose={closeWorktree}
        onarchive={toggleWorktreeArchived}
        onmerge={(branch) => { mergeBranch = branch; }}
        onremove={(b) => (removeBranch = b)}
        onedit={(branch) => { editWorktreeBranch = branch; }}
      />

      {#if showCreateScratchDialog}
        <CreateScratchDialog
          projectName={projects.find((p) => p.id === currentProjectId)?.name ?? "Unknown project"}
          projects={projects}
          defaultProjectId={currentProjectId ?? projects[0]?.id ?? ""}
          onProjectChange={(id) => { currentProjectId = id; }}
          agentChoices={config.agents.map((a) => ({ id: a.id, label: a.id }))}
          onClose={() => { showCreateScratchDialog = false; }}
          onCreate={handleCreateScratch}
        />
      {/if}

      {#if showCreateAISessionDialog}
        <CreateScratchDialog
          projectName={projects.find((p) => p.id === currentProjectId)?.name ?? "Unknown project"}
          projects={projects}
          defaultProjectId={currentProjectId ?? projects[0]?.id ?? ""}
          onProjectChange={(id) => { currentProjectId = id; }}
          agentChoices={config.agents.map((a) => ({ id: a.id, label: a.label ?? a.id }))}
          lockedKind="agent"
          onClose={() => { showCreateAISessionDialog = false; }}
          onCreate={async (req) => {
            await handleCreateScratch(req);
            showCreateAISessionDialog = false;
          }}
        />
      {/if}

      {#if config.projectDir}
        <SidebarRepoRow
          label={config.mainBranch ?? "main"}
          cursorUrl={makeCursorUrl(config.projectDir, sshHost) ?? ""}
          onpull={() => { pullMainConfirm = true; pullMainForce = false; pullMainError = ""; }}
        />
      {/if}
      {#each (config.linkedRepos ?? []).filter((lr) => lr.dir) as lr (lr.alias)}
        <SidebarRepoRow
          label={lr.alias}
          cursorUrl={makeCursorUrl(lr.dir, sshHost) ?? ""}
          onpull={() => { pullLinkedRepoAlias = lr.alias; pullLinkedRepoForce = false; pullLinkedRepoError = ""; }}
        />
      {/each}
      {#if showLinearPanel}
        <LinearPanel
          issues={linearIssues}
          availability={linearAvailability}
          onassign={handleAssignIssue}
          onselect={(issue) => (detailIssue = issue)}
        />
      {/if}
      {#if !isMobile}
        <div
          class="shrink-0 border-t border-edge px-4 py-3 text-[11px] text-muted flex flex-col gap-1"
        >
          <div class="flex justify-between">
            <span>Navigate</span><kbd class="opacity-60">Cmd+Up/Down</kbd>
          </div>
          <div class="flex justify-between">
            <span>New worktree</span><kbd class="opacity-60">Cmd+K</kbd>
          </div>
          <div class="flex justify-between">
            <span>Merge</span><kbd class="opacity-60">Cmd+M</kbd>
          </div>
          <div class="flex justify-between">
            <span>Remove</span><kbd class="opacity-60">Cmd+D</kbd>
          </div>
        </div>
      {/if}
    </aside>
    {#if !isMobile}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (focusable ARIA separator used for keyboard-resizable sidebar) -->
      <div
        class="w-1 shrink-0 cursor-col-resize hover:bg-accent/50 transition-colors"
        class:bg-accent={isResizingSidebar}
        onpointerdown={handleResizeStart}
        onkeydown={handleResizeKeydown}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabindex="0"
      ></div>
    {/if}
  {/if}

  <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
    <TopBar
      name={selectedWorktree?.branch ?? null}
      worktree={selectedWorktree}
      {sshHost}
      linkedRepos={config.linkedRepos ?? []}
      {isMobile}
      {showMobileChat}
      {showViewToggle}
      {notificationHistory}
      {unreadCount}
      ontogglesidebar={() => (sidebarOpen = !sidebarOpen)}
      ontoggleview={() => {
        mobileViewOverride = showMobileChat ? "terminal" : "chat";
        localStorage.setItem("webmux.viewOverride", mobileViewOverride);
      }}
      onclose={handleClose}
      onarchive={handleArchiveToggle}
      onmerge={() => {
        if (selectedBranch) mergeBranch = selectedBranch;
      }}
      onremove={() => {
        if (selectedBranch) removeBranch = selectedBranch;
      }}
      onsettings={() => (showSettingsDialog = true)}
      ondirtyclick={openDiffDialog}
      onCiClick={(pr) => (ciDetailsPr = pr)}
      onReviewsClick={(pr) => (commentReviewPr = pr)}
      onbellopen={handleBellOpen}
      onnotificationselect={handleSelectWorktreeByBranch}
      archiving={isSelectedArchiving}
    />


    {#if selection?.kind === "worktree" && supportsSessionChat(selection)}
      <div class="contents" class:hidden={!showMobileChat}>
        {#key selectedBranch}
          <MobileChatSurface projectId={currentProjectId!} worktree={selectedWorktree!} {isMobile} />
        {/key}
      </div>
    {/if}
    {#if selection?.kind === "scratch" && supportsSessionChat(selection)}
      <div class="contents" class:hidden={!showMobileChat}>
        {#key selection.id}
          <MobileChatSurface
            projectId={currentProjectId!}
            target={{ kind: "scratch", projectId: currentProjectId!, scratchId: selection.id }}
            {isMobile}
          />
        {/key}
      </div>
    {/if}
    {#if !showMobileChat}
    {#if selection && (selection.kind !== "worktree" || canConnect)}
      {#key selection.kind === "worktree" ? selection.branch : selection.kind === "external" ? selection.sessionName : selection.id}
        <Terminal
          {selection}
          {isMobile}
          initialPane={isMobile ? activePane : undefined}
          {terminalTheme}
          bind:this={terminalRef}
        />
      {/key}
    {:else if selectedWorktree?.creating}
      <div class="flex-1 flex items-center justify-center px-6">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="spinner" style="width: 24px; height: 24px; border-width: 2px;"></span>
          <p class="text-sm text-primary font-medium">{selectedWorktree.branch}</p>
          <p class="text-xs text-muted">{worktreeCreationPhaseLabel(selectedWorktree.creationPhase)}</p>
        </div>
      </div>
    {:else if selectedWorktree}
      <div class="flex-1 flex items-center justify-center px-6">
        <div class="flex flex-col items-center gap-4 text-center">
          <p class="text-sm text-primary font-medium">{selectedWorktree.branch}</p>
          <div class="flex flex-col items-center gap-1">
            {#if selectedWorktree.profile}
              <span class="text-xs text-muted">Profile: {selectedWorktree.profile}</span>
            {/if}
            {#if selectedWorktree.agentLabel ?? selectedWorktree.agentName}
              <span class="text-xs text-muted">Agent: {selectedWorktree.agentLabel ?? selectedWorktree.agentName}</span>
            {/if}
            {#if selectedWorktree.agentName && !supportsWorktreeChat(selectedWorktree)}
              <span class="text-xs text-muted">This agent runs in the terminal only.</span>
            {/if}
          </div>
          <div class="mt-2 flex items-stretch">
            <button
              class="px-5 py-2 rounded-l-md bg-accent text-white text-sm font-medium cursor-pointer border-none hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              onclick={openSelectedWorktree}
              disabled={isSelectedOpening}
            >
              {#if isSelectedOpening}
                <span class="spinner" style="width: 14px; height: 14px; border-width: 1.5px;"></span>
                Opening...
              {:else}
                Open Session
              {/if}
            </button>
            <button
              bind:this={openWithCaretEl}
              type="button"
              class="px-2 py-2 rounded-r-md bg-accent text-white text-sm cursor-pointer border-none border-l border-white/20 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={toggleOpenWithMenu}
              disabled={isSelectedOpening}
              aria-label="Open with options"
              aria-haspopup="true"
              aria-expanded={openWithMenuOpen}
            >
              ▾
            </button>
          </div>

          {#if openWithMenuOpen}
            <div
              class="fixed z-50 rounded-md border border-edge bg-sidebar shadow-md min-w-[200px]"
              style:top="{openWithMenuTop}px"
              style:left="{openWithMenuLeft}px"
              style="transform: translateX(-50%);"
              role="menu"
              aria-label="Open session with…"
            >
              {#if config.agents.length > 0}
                <div role="group" aria-label="Open with another agent">
                  <div class="px-3 py-1 text-[11px] uppercase tracking-wider text-muted/70">Open with another agent</div>
                  {#each config.agents as agent (agent.id)}
                    {@const isDefault = agent.id === selectedWorktree.agentName}
                    <button
                      type="button"
                      class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                      onclick={() => { void openSelectedWorktreeWith({ agentOverride: agent.id }); }}
                      disabled={isDefault}
                      role="menuitem"
                    >
                      {agent.label}
                      {#if isDefault}<span class="ml-1 text-muted text-[11px]">(default)</span>{/if}
                    </button>
                  {/each}
                </div>
                <div class="my-1 border-t border-edge"></div>
              {/if}
              <button
                type="button"
                class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover"
                onclick={() => { void openSelectedWorktreeWith({ shellOnly: true }); }}
                role="menuitem"
              >
                Shell only
              </button>
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex-1 flex items-center justify-center text-muted text-sm">
        <p>Select a worktree from the sidebar to connect</p>
      </div>
    {/if}
    {/if}

    {#if showPaneBar}
      <PaneBar {activePane} panes={paneBarPanes} onselect={handlePaneSelect} />
    {/if}
  </main>
</div>

{#if showAddProjectDialog}
  <AddProjectDialog
    onClose={() => { showAddProjectDialog = false; }}
    onCreate={handleAddProject}
  />
{/if}

{#if projectToRemove}
  <ConfirmRemoveProjectDialog
    projectName={projectToRemove.name}
    onConfirm={(killSessions) => { void handleConfirmRemoveProject(killSessions); }}
    onCancel={() => { projectToRemove = null; }}
  />
{/if}

{#if showCreateDialog}
  <CreateWorktreeDialog
    profiles={config.profiles}
    agents={config.agents}
    defaultProfileName={config.defaultProfileName}
    defaultAgentId={config.defaultAgentId}
    autoNameEnabled={config.autoName}
    initialBranch={assignIssue?.branchName ?? ""}
    initialPrompt={assignIssue ? `${assignIssue.title}${assignIssue.description ? '\n\n' + assignIssue.description : ''}` : ""}
    bind:includeRemoteBranches
    {availableBranches}
    {availableBranchesLoading}
    {availableBranchesError}
    {baseBranches}
    {baseBranchesLoading}
    {baseBranchesError}
    startupEnvs={config.startupEnvs ?? {}}
    linearCreateTicketOption={config.linearCreateTicketOption}
    openedFromLinearIssue={assignIssue !== null}
    {projects}
    defaultProjectId={currentProjectId ?? projects[0]?.id ?? ""}
    onProjectChange={(id) => { currentProjectId = id; }}
    oncreate={handleCreate}
    oncancel={() => { showCreateDialog = false; assignIssue = null; }}
  />
{/if}

{#if removeBranch}
  {@const removingWt = currentWorktrees.find((w) => w.branch === removeBranch)}
  <ConfirmDialog
    message={removingWt?.orphaned
      ? `Worktree "${removeBranch}" has no git registration left. Removing it will kill the tmux window (the branch and any commits stay). Continue?`
      : `Remove worktree "${removeBranch}"? This action cannot be undone.`}
    onconfirm={handleRemove}
    oncancel={() => (removeBranch = null)}
  />
{/if}

{#if editWorktreeBranch}
  {@const editWorktree = currentWorktrees.find((w) => w.branch === editWorktreeBranch)}
  {#if editWorktree}
    <EditWorktreeDialog
      worktree={editWorktree}
      agents={config.agents}
      onsave={(yolo, agent) => handleSaveEditWorktree(editWorktreeBranch!, yolo, agent)}
      onclose={() => { editWorktreeBranch = null; }}
    />
  {/if}
{/if}

{#if scratchToRemove}
  <ConfirmDialog
    message={`Remove scratch session "${scratchToRemove.displayName}"? The tmux session will be killed.`}
    onconfirm={() => { void confirmRemoveScratch(); }}
    oncancel={() => (scratchToRemove = null)}
  />
{/if}

{#if mergeBranch}
  <ConfirmDialog
    message={`Merge worktree "${mergeBranch}" into main? The worktree will be removed after merging.`}
    confirmLabel="Merge"
    variant="accent"
    onconfirm={handleMerge}
    oncancel={() => (mergeBranch = null)}
  />
{/if}

{#if pullMainConfirm}
  <ConfirmDialog
    message={pullMainForce
      ? `Force pull "${config.mainBranch ?? "main"}"? This will discard any local commits on main.`
      : `Pull latest "${config.mainBranch ?? "main"}" from remote?`}
    confirmLabel={pullMainForce ? "Force Pull" : "Pull"}
    variant={pullMainForce ? "danger" : "accent"}
    loading={pullMainLoading}
    error={pullMainError}
    onconfirm={handlePullMain}
    oncancel={() => { pullMainConfirm = false; pullMainForce = false; }}
  />
{/if}

{#if pullLinkedRepoAlias}
  <ConfirmDialog
    message={pullLinkedRepoForce
      ? `Force pull "${pullLinkedRepoAlias}"? This will discard any local commits.`
      : `Pull latest "${pullLinkedRepoAlias}" from remote?`}
    confirmLabel={pullLinkedRepoForce ? "Force Pull" : "Pull"}
    variant={pullLinkedRepoForce ? "danger" : "accent"}
    loading={pullLinkedRepoLoading}
    error={pullLinkedRepoError}
    onconfirm={handlePullLinkedRepo}
    oncancel={() => { pullLinkedRepoAlias = null; pullLinkedRepoForce = false; }}
  />
{/if}

{#if showSettingsDialog}
  <SettingsDialog
    projectId={currentProjectId!}
    {currentTheme}
    linearAutoCreate={config.linearAutoCreateWorktrees ?? false}
    autoRemoveOnMerge={config.autoRemoveOnMerge ?? false}
    onthemechange={(key) => (currentTheme = key)}
    onlinearautocreatechange={(enabled) => { config.linearAutoCreateWorktrees = enabled; }}
    onautoremovechange={(enabled) => { config.autoRemoveOnMerge = enabled; }}
    onagentschange={(agents) => { config.agents = agents; }}
    onsave={(host) => {
      sshHost = host;
      showSettingsDialog = false;
    }}
    onclose={() => (showSettingsDialog = false)}
  />
{/if}

{#if ciDetailsPr}
  <CiDetailsDialog
    pr={ciDetailsPr}
    branch={selectedWorktree?.branch ?? ""}
    onclose={() => (ciDetailsPr = null)}
    onfixsuccess={() => {
      ciDetailsPr = null;
      setTimeout(() => terminalRef?.sendInput("\r"), ENTER_DELAY_MS);
    }}
  />
{/if}

{#if commentReviewPr}
  <CommentReviewDialog
    pr={commentReviewPr}
    branch={selectedWorktree?.branch ?? ""}
    onclose={() => (commentReviewPr = null)}
    onsendsuccess={() => {
      commentReviewPr = null;
      setTimeout(() => terminalRef?.sendInput("\r"), ENTER_DELAY_MS);
    }}
  />
{/if}

{#if showDiffDialog && selectedBranch && DiffDialogComponent}
  <DiffDialogComponent
    branch={selectedBranch}
    cursorUrl={makeCursorUrl(selectedWorktree?.dir, sshHost)}
    onclose={() => (showDiffDialog = false)}
  />
{/if}

{#if detailIssue}
  <LinearDetailDialog
    issue={detailIssue}
    onassign={(issue) => { detailIssue = null; handleAssignIssue(issue); }}
    onclose={() => (detailIssue = null)}
  />
{/if}

<ToastStack
  {toasts}
  ondismiss={handleDismissToast}
  onselect={handleSelectToast}
/>
