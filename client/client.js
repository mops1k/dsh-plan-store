/**
 * dsh-plan-store client half (classic browser module).
 *
 * Registered through the dsh module loader: a `conversation.view` kanban board
 * (swimlanes = plans, columns = task statuses, cards = tasks with HTML5
 * drag&drop), a `conversation.view` goal/todo tab for the current session, and
 * the settings card for the plugin namespace. Both views are opened from the
 * view tabs next to the conversation — the plugin adds no sidebar buttons.
 *
 * Authoritative source: build copies this file to `lib/client.js`
 * (see scripts/copy-client.mjs). Kept as plain classic JS on purpose — the dsh
 * client has no bundler for third-party plugin clients.
 */
window.__ModuleLoader__.load({
  id: "dsh-plan-store",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    const NAMESPACE = "dsh-plan-store";
    const DEFAULT_WEB_PATH = "/plan-store";
    const VIEW_ID = "plan-board";
    const VIEW_LABEL = "Plan Board";
    const GOALS_ID = "goals-todos";
    const GOALS_LABEL = "Goals & Todos";
    const ORDER = 40;

    const TASK_STATUSES = ["todo", "doing", "blocked", "done"];
    const TASK_STATUS_LABELS = { todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" };
    const PLAN_STATUSES = ["backlog", "active", "blocked", "done", "archived"];
    const PRIORITIES = ["low", "normal", "high", "urgent"];

    /* ------------------------------------------------------------------ *
     * helpers
     * ------------------------------------------------------------------ */

    function normalizeBase(value) {
      let raw = typeof value === "string" ? value.trim() : "";
      if (raw.length === 0) raw = DEFAULT_WEB_PATH;
      if (raw.charAt(0) !== "/") raw = "/" + raw;
      raw = raw.replace(/\/+$/, "");
      return raw.length === 0 ? DEFAULT_WEB_PATH : raw;
    }

    function webBase(scope) {
      let snapshot = null;
      try {
        snapshot = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
      } catch {
        snapshot = null;
      }
      const value = snapshot && snapshot.value ? snapshot.value : null;
      return normalizeBase(value ? value.webPath : undefined);
    }

    function joinUrl(base, path) {
      return String(base).replace(/\/+$/, "") + path;
    }

    function errorText(error) {
      return error && error.message ? error.message : String(error);
    }

    async function apiGet(scope, path) {
      const response = await fetch(joinUrl(webBase(scope), path), { headers: { Accept: "application/json" } });
      const text = await response.text();
      let data = null;
      try {
        data = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!response.ok) {
        throw new Error((data && data.error) || "Request failed with status " + response.status);
      }
      return data || {};
    }

    async function apiPost(scope, path, body) {
      const response = await fetch(joinUrl(webBase(scope), path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const text = await response.text();
      let data = null;
      try {
        data = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!response.ok) {
        throw new Error((data && data.error) || "Request failed with status " + response.status);
      }
      return data || {};
    }

    function progressPercent(progress) {
      if (!progress || typeof progress.percent !== "number") return 0;
      return Math.max(0, Math.min(100, progress.percent));
    }

    function progressLabel(progress) {
      if (!progress) return "0/0";
      return String(progress.done || 0) + "/" + String(progress.total || 0);
    }

    function byPosition(left, right) {
      const a = typeof left.position === "number" ? left.position : 0;
      const b = typeof right.position === "number" ? right.position : 0;
      if (a !== b) return a - b;
      return String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    }

    function truncate(value, limit) {
      const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
      return text.length <= limit ? text : text.slice(0, limit) + "…";
    }

    function linesToList(value) {
      return String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    function listToLines(value) {
      return Array.isArray(value) ? value.join("\n") : "";
    }

    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot();
        const current = snapshot ? snapshot.current : null;
        return typeof current === "string" && current.length > 0 ? current : null;
      } catch {
        return null;
      }
    }

    function subscribeSessions(ctx, callback) {
      try {
        return ctx.sessions.list.subscribe(callback);
      } catch {
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * styles
     * ------------------------------------------------------------------ */

    const S = {
      // Surfaces and text use the dsh design tokens, with dark fallbacks for
      // hosts that do not define them. Native popups (select options) get the
      // same tokens so the expanded list stays readable instead of falling back
      // to the browser default white.
      root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "420px",
        overflow: "hidden",
        color: "var(--dsw-alias-label-primary, inherit)",
        font: "inherit",
      },
      toolbar: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        alignItems: "center",
        padding: "10px 12px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
      },
      input: {
        background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
        borderRadius: "6px",
        padding: "5px 8px",
        fontSize: "12px",
        minWidth: "120px",
      },
      option: {
        background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #242424))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
      },
      button: {
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
        borderRadius: "6px",
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
      },
      primary: {
        background: "var(--dsw-alias-bg-layer-3, rgba(64,140,255,0.18))",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-state-business-primary, rgba(64,140,255,0.55))",
        borderRadius: "6px",
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
      },
      danger: {
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-state-error-primary, rgba(220,80,80,0.55))",
        borderRadius: "6px",
        padding: "5px 10px",
        fontSize: "12px",
        cursor: "pointer",
      },
      disabled: { opacity: 0.55, cursor: "default" },
      board: { flex: "1 1 auto", overflow: "auto", padding: "12px" },
      lane: {
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        borderRadius: "8px",
        marginBottom: "12px",
        background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05))",
      },
      laneHead: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        alignItems: "center",
        padding: "8px 10px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))",
      },
      laneTitle: {
        fontSize: "13px",
        fontWeight: 600,
        margin: 0,
        color: "var(--dsw-alias-label-primary, inherit)",
      },
      laneNote: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)", opacity: 0.85, padding: "4px 10px 0" },
      cardNote: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)", opacity: 0.85, marginTop: "2px" },
      badge: {
        fontSize: "10px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--dsw-alias-label-secondary, inherit)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.45))",
        borderRadius: "999px",
        padding: "1px 7px",
      },
      bar: {
        flex: "0 0 120px",
        height: "6px",
        borderRadius: "999px",
        background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.28))",
        overflow: "hidden",
      },
      barFill: { height: "100%", background: "var(--dsw-alias-state-business-primary, rgba(64,140,255,0.85))" },
      muted: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)", opacity: 0.85 },
      phase: {
        borderTop: "1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,0.25))",
        padding: "8px 10px",
      },
      phaseHead: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "6px" },
      columns: { display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "8px" },
      column: {
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))",
        borderRadius: "6px",
        minHeight: "54px",
        padding: "6px",
        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.04))",
      },
      columnHead: {
        fontSize: "10px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--dsw-alias-label-caption, inherit)",
        opacity: 0.85,
        marginBottom: "5px",
      },
      card: {
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
        borderRadius: "6px",
        padding: "6px 7px",
        marginBottom: "5px",
        background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.1))",
        color: "var(--dsw-alias-label-primary, inherit)",
        cursor: "grab",
        fontSize: "12px",
      },
      cardDone: { opacity: 0.65, textDecoration: "line-through" },
      cardMeta: { fontSize: "10px", color: "var(--dsw-alias-label-caption, inherit)", opacity: 0.85, marginTop: "3px" },
      banner: {
        padding: "7px 12px",
        fontSize: "12px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
      },
      error: { color: "var(--dsw-alias-state-error-primary, #ff9a9a)" },
      drawer: {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "360px",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "12px",
        overflowY: "auto",
        background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #1e1e1e))",
        color: "var(--dsw-alias-label-primary, inherit)",
        borderLeft: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
        boxShadow: "var(--dsw-elevation-prominent, -8px 0 24px rgba(0,0,0,0.28))",
      },
      modal: {
        position: "fixed",
        inset: "0",
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.45))",
      },
      modalBody: {
        width: "440px",
        maxWidth: "92vw",
        maxHeight: "86vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "14px",
        borderRadius: "10px",
        background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #1e1e1e))",
        color: "var(--dsw-alias-label-primary, inherit)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.35))",
      },
      field: {
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        fontSize: "11px",
        color: "var(--dsw-alias-label-secondary, inherit)",
      },
      textarea: {
        background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
        borderRadius: "6px",
        padding: "6px 8px",
        fontSize: "12px",
        minHeight: "64px",
        resize: "vertical",
      },
      row: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" },
      spacer: { flex: "1 1 auto" },
    };

    /* ------------------------------------------------------------------ *
     * small building blocks
     * ------------------------------------------------------------------ */

    function ProgressBar(props) {
      const percent = progressPercent(props.progress);
      return h(
        "div",
        { style: S.bar, title: progressLabel(props.progress) + " (" + percent + "%)" },
        h("div", { style: Object.assign({}, S.barFill, { width: percent + "%" }) }),
      );
    }

    function Select(props) {
      return h(
        "select",
        {
          style: S.input,
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        },
        (props.options || []).map((option) =>
          h(
            "option",
            { key: option, value: option, style: S.option },
            (props.labels && props.labels[option]) || option,
          ),
        ),
      );
    }

    function Field(props) {
      return h(
        "label",
        { style: S.field },
        h("span", null, props.label),
        props.children,
      );
    }

    function Modal(props) {
      return h(
        "div",
        { style: S.modal, role: "dialog", "aria-label": props.title },
        h(
          "div",
          { style: S.modalBody },
          h("h3", { style: S.laneTitle }, props.title),
          props.children,
          h(
            "div",
            { style: S.row },
            h("div", { style: S.spacer }),
            h("button", { type: "button", style: S.button, onClick: props.onCancel }, "Cancel"),
            h(
              "button",
              {
                type: "button",
                style: props.busy ? Object.assign({}, S.primary, S.disabled) : S.primary,
                disabled: props.busy === true,
                onClick: props.onSubmit,
              },
              props.submitLabel || "Create",
            ),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * kanban board
     * ------------------------------------------------------------------ */

    function createBoardView(ctx, scope) {
      return function PlanBoard() {
        const [data, setData] = React.useState({ plans: [], total: 0, workspaces: [] });
        const [filters, setFilters] = React.useState({ workspace: "", status: "all", query: "", includeArchived: false });
        // The board opens on the project of the current session; an explicit
        // choice by the user always wins.
        const [sessionWorkspace, setSessionWorkspace] = React.useState(null);
        const [workspaceChosen, setWorkspaceChosen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const [notice, setNotice] = React.useState("");
        const [drawer, setDrawer] = React.useState(null);
        const [modal, setModal] = React.useState(null);
        const [dragging, setDragging] = React.useState(null);
        // Manual lane toggles (plan id -> explicitly open). Lanes that the user
        // never touched follow the status default: active/blocked open, the
        // rest (backlog, done, archived) collapsed. Kept in memory on purpose:
        // a page reload returns to the default view.
        const [laneOpen, setLaneOpen] = React.useState({});

        const query = React.useMemo(() => {
          const parts = ["limit=200"];
          if (filters.workspace) parts.push("workspace=" + encodeURIComponent(filters.workspace));
          if (filters.status && filters.status !== "all") parts.push("status=" + encodeURIComponent(filters.status));
          if (filters.query) parts.push("query=" + encodeURIComponent(filters.query));
          if (filters.includeArchived) parts.push("includeArchived=true");
          return "/api/plans?" + parts.join("&");
        }, [filters.workspace, filters.status, filters.query, filters.includeArchived]);

        React.useEffect(() => {
          let cancelled = false;
          const resolveSessionWorkspace = async () => {
            const sessionId = currentSessionId(ctx);
            try {
              const suffix = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
              const payload = await apiGet(scope, "/api/session/state" + suffix);
              const key = payload && payload.state && payload.state.workspace ? payload.state.workspace.key : null;
              if (!cancelled) setSessionWorkspace(typeof key === "string" && key.length > 0 ? key : null);
            } catch {
              if (!cancelled) setSessionWorkspace(null);
            }
          };
          resolveSessionWorkspace();
          const unsubscribe = subscribeSessions(ctx, resolveSessionWorkspace);
          return () => {
            cancelled = true;
            if (unsubscribe) unsubscribe();
          };
        }, []);

        React.useEffect(() => {
          if (sessionWorkspace === null || workspaceChosen) return;
          setFilters((previous) =>
            previous.workspace === "" ? Object.assign({}, previous, { workspace: sessionWorkspace }) : previous,
          );
        }, [sessionWorkspace, workspaceChosen]);

        const workspaceOptions = React.useMemo(() => {
          const keys = data.workspaces.map((workspace) => workspace.key);
          if (sessionWorkspace !== null && keys.indexOf(sessionWorkspace) < 0) keys.unshift(sessionWorkspace);
          return [""].concat(keys);
        }, [data.workspaces, sessionWorkspace]);

        const load = React.useCallback(async () => {
          setBusy(true);
          setError("");
          try {
            const payload = await apiGet(scope, query);
            setData({
              plans: Array.isArray(payload.plans) ? payload.plans : [],
              total: typeof payload.total === "number" ? payload.total : 0,
              workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
            });
          } catch (loadError) {
            setError("Cannot load plans: " + errorText(loadError));
          } finally {
            setBusy(false);
          }
        }, [query]);

        React.useEffect(() => {
          load();
        }, [load]);

        const applyPlan = (plan) => {
          if (!plan) return;
          setData((previous) => ({
            plans: previous.plans.map((item) => (item.id === plan.id ? plan : item)),
            total: previous.total,
            workspaces: previous.workspaces,
          }));
        };

        const mutate = async (path, body, message) => {
          setBusy(true);
          setError("");
          try {
            const payload = await apiPost(scope, path, body);
            applyPlan(payload.plan);
            if (message) setNotice(message);
            return payload;
          } catch (mutateError) {
            setError(errorText(mutateError));
            await load();
            return null;
          } finally {
            setBusy(false);
          }
        };

        const findTask = (taskId) => {
          for (const plan of data.plans) {
            for (const phase of plan.phases || []) {
              for (const task of phase.tasks || []) {
                if (task.id === taskId) return { plan, phase, task };
              }
            }
          }
          return null;
        };

        const moveTask = async (taskId, status, phaseId, position) => {
          const found = findTask(taskId);
          if (!found) return;
          const body = { id: taskId, status, phaseId };
          if (typeof position === "number") body.position = position;
          // Optimistic update so the card lands where it was dropped.
          setData((previous) => ({
            plans: previous.plans.map((plan) => {
              if (plan.id !== found.plan.id) return plan;
              const phases = (plan.phases || []).map((phase) => {
                let tasks = (phase.tasks || []).filter((task) => task.id !== taskId);
                if (phase.id === phaseId) {
                  const moved = Object.assign({}, found.task, { status, phaseId });
                  tasks = tasks.concat([moved]);
                }
                return Object.assign({}, phase, { tasks });
              });
              return Object.assign({}, plan, { phases });
            }),
            total: previous.total,
            workspaces: previous.workspaces,
          }));
          await mutate("/api/task/move", body, "");
        };

        const openTask = (taskId) => {
          const found = findTask(taskId);
          if (found) setDrawer({ kind: "task", id: taskId });
        };

        const renderCard = (task, phase) =>
          h(
            "div",
            {
              key: task.id,
              style: Object.assign({}, S.card, task.status === "done" ? S.cardDone : {}),
              draggable: true,
              onDragStart: (event) => {
                try {
                  event.dataTransfer.setData("text/plain", task.id);
                  event.dataTransfer.effectAllowed = "move";
                } catch {
                  /* ignore */
                }
                setDragging(task.id);
              },
              onDragEnd: () => setDragging(null),
              onDragOver: (event) => {
                event.preventDefault();
                event.stopPropagation();
              },
              onDrop: (event) => {
                event.preventDefault();
                event.stopPropagation();
                const id = event.dataTransfer.getData("text/plain") || dragging;
                setDragging(null);
                if (!id || id === task.id) return;
                const index = (phase.tasks || []).filter((item) => item.status === task.status).indexOf(task);
                moveTask(id, task.status, phase.id, index < 0 ? undefined : index);
              },
              onClick: () => openTask(task.id),
              title: task.notes || task.title,
            },
            h("div", null, task.title),
            task.notes ? h("div", { style: S.cardNote }, truncate(task.notes, 110)) : null,
            h(
              "div",
              { style: S.cardMeta },
              [task.notes ? "note" : null, (task.links || []).length > 0 ? String(task.links.length) + " link(s)" : null]
                .filter(Boolean)
                .join(" · "),
            ),
          );

        const renderPhase = (plan, phase) =>
          h(
            "div",
            { key: phase.id, style: S.phase },
            h(
              "div",
              { style: S.phaseHead },
              h("strong", { style: { fontSize: "12px" } }, phase.title),
              h("span", { style: S.badge }, phase.status),
              h("span", { style: S.muted }, progressLabel(phase.progress)),
              h("div", { style: S.spacer }),
              h(
                "button",
                {
                  type: "button",
                  style: S.button,
                  onClick: () => setModal({ kind: "task", planId: plan.id, phaseId: phase.id }),
                },
                "+ Task",
              ),
              h(
                "button",
                {
                  type: "button",
                  style: S.danger,
                  onClick: () => mutate("/api/phase/delete", { id: phase.id }, "Phase deleted"),
                },
                "Delete phase",
              ),
            ),
            phase.notes ? h("div", { style: S.laneNote }, truncate(phase.notes, 180)) : null,
            h(
              "div",
              { style: S.columns },
              TASK_STATUSES.map((status) => {
                const tasks = (phase.tasks || []).filter((task) => task.status === status).sort(byPosition);
                return h(
                  "div",
                  {
                    key: status,
                    style: S.column,
                    onDragOver: (event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    },
                    onDrop: (event) => {
                      event.preventDefault();
                      const id = event.dataTransfer.getData("text/plain") || dragging;
                      setDragging(null);
                      if (!id) return;
                      moveTask(id, status, phase.id, undefined);
                    },
                  },
                  h("div", { style: S.columnHead }, TASK_STATUS_LABELS[status] + " (" + tasks.length + ")"),
                  tasks.map((task) => renderCard(task, phase)),
                );
              }),
            ),
          );

        /** Whether one plan lane renders collapsed right now. */
        const laneCollapsed = (plan) =>
          Object.prototype.hasOwnProperty.call(laneOpen, plan.id)
            ? !laneOpen[plan.id]
            : plan.status !== "active" && plan.status !== "blocked";

        /** Flip one lane, remembering the user's explicit choice. */
        const toggleLane = (plan) =>
          setLaneOpen((previous) => Object.assign({}, previous, { [plan.id]: laneCollapsed(plan) }));

        const renderLane = (plan) => {
          const collapsed = laneCollapsed(plan);
          return h(
            "div",
            { key: plan.id, style: S.lane },
            h(
              "div",
              { style: S.laneHead },
              h(
                "button",
                {
                  type: "button",
                  style: S.button,
                  title: collapsed ? "Expand plan" : "Collapse plan",
                  "aria-expanded": !collapsed,
                  onClick: () => toggleLane(plan),
                },
                collapsed ? "\u25B8" : "\u25BE",
              ),
              h(
                "h3",
                {
                  style: Object.assign({}, S.laneTitle, { cursor: "pointer" }),
                  onClick: () => toggleLane(plan),
                },
                plan.title,
              ),
              h("span", { style: S.badge }, plan.status),
              plan.priority !== "normal" ? h("span", { style: S.badge }, plan.priority) : null,
              plan.workspace ? h("span", { style: S.muted }, plan.workspace) : null,
              h(ProgressBar, { progress: plan.progress }),
              h("span", { style: S.muted }, progressLabel(plan.progress) + " · " + (plan.phases || []).length + " phase(s)"),
              h("div", { style: S.spacer }),
              h(
                "button",
                { type: "button", style: S.button, onClick: () => setModal({ kind: "phase", planId: plan.id }) },
                "+ Phase",
              ),
              h(
                "button",
                { type: "button", style: S.button, onClick: () => setDrawer({ kind: "plan", id: plan.id }) },
                "Edit",
              ),
              h(
                "button",
                {
                  type: "button",
                  style: S.button,
                  onClick: () => mutate("/api/export", { id: plan.id }, "Exported to " + (plan.workspace || "workspace")),
                },
                "Export",
              ),
              plan.status === "archived"
                ? h(
                    "button",
                    {
                      type: "button",
                      style: S.button,
                      onClick: () => mutate("/api/plan/update", { id: plan.id, status: "backlog" }, "Restored"),
                    },
                    "Restore",
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      style: S.danger,
                      onClick: () => mutate("/api/plan/delete", { id: plan.id }, "Archived"),
                    },
                    "Archive",
                  ),
            ),
            collapsed
              ? null
              : h(React.Fragment, null, [
                  plan.description
                    ? h("div", { key: "note", style: S.laneNote }, truncate(plan.description, 180))
                    : null,
                  (plan.phases || []).map((phase) => renderPhase(plan, phase)),
                  (plan.phases || []).length === 0
                    ? h("div", { key: "empty", style: S.phase }, h("span", { style: S.muted }, "No phases yet."))
                    : null,
                ]),
          );
        };

        return h(
          "div",
          { style: S.root },
          h(
            "div",
            { style: S.toolbar },
            h(Select, {
              value: filters.workspace,
              options: workspaceOptions,
              labels: { "": "All workspaces" },
              onChange: (value) => {
                setWorkspaceChosen(true);
                setFilters(Object.assign({}, filters, { workspace: value }));
              },
            }),
            h(Select, {
              value: filters.status,
              options: ["all"].concat(PLAN_STATUSES),
              labels: { all: "All statuses" },
              onChange: (value) => setFilters(Object.assign({}, filters, { status: value })),
            }),
            h("input", {
              style: S.input,
              placeholder: "Filter by text…",
              value: filters.query,
              onChange: (event) => setFilters(Object.assign({}, filters, { query: event.target.value })),
            }),
            h(
              "label",
              { style: Object.assign({}, S.muted, { display: "flex", gap: "4px", alignItems: "center" }) },
              h("input", {
                type: "checkbox",
                checked: filters.includeArchived,
                onChange: (event) => setFilters(Object.assign({}, filters, { includeArchived: event.target.checked })),
              }),
              "archived",
            ),
            h("div", { style: S.spacer }),
            h("span", { style: S.muted }, busy ? "working…" : data.plans.length + " of " + data.total + " plan(s)"),
            h("button", { type: "button", style: S.button, onClick: load, disabled: busy }, "Refresh"),
            h(
              "button",
              { type: "button", style: S.primary, onClick: () => setModal({ kind: "plan" }) },
              "+ New plan",
            ),
          ),
          error ? h("div", { style: Object.assign({}, S.banner, S.error) }, error) : null,
          notice ? h("div", { style: S.banner }, notice) : null,
          h(
            "div",
            { style: S.board },
            data.plans.length === 0
              ? h("p", { style: S.muted }, "No plans yet. Create one with “+ New plan” or the plan_create tool.")
              : data.plans.map((plan) => renderLane(plan)),
          ),
          drawer ? renderDrawer(drawer) : null,
          modal ? renderModal(modal) : null,
        );

        /* ------------------------- drawer ------------------------- */

        function renderDrawer(state) {
          const plan = data.plans.find((item) => item.id === state.id) || null;
          if (state.kind === "plan") {
            if (!plan) return null;
            return h(PlanDrawer, {
              plan: plan,
              mutate: mutate,
              onClose: () => setDrawer(null),
            });
          }
          let found = null;
          for (const candidate of data.plans) {
            for (const phase of candidate.phases || []) {
              for (const task of phase.tasks || []) {
                if (task.id === state.id) found = { plan: candidate, phase, task };
              }
            }
          }
          if (!found) return null;
          return h(TaskDrawer, {
            task: found.task,
            plan: found.plan,
            phase: found.phase,
            onClose: () => setDrawer(null),
            onSaved: (updated) => {
              applyPlan(updated);
              setDrawer(null);
            },
            mutate: mutate,
          });
        }

        function PlanDrawer(props) {
          const [form, setForm] = React.useState({
            title: props.plan.title,
            description: props.plan.description || "",
            status: props.plan.status,
            priority: props.plan.priority,
            tags: (props.plan.tags || []).join(", "),
          });
          const [events, setEvents] = React.useState(props.plan.events || []);
          React.useEffect(() => {
            let cancelled = false;
            (async () => {
              try {
                const payload = await apiGet(scope, "/api/plan?id=" + encodeURIComponent(props.plan.id) + "&eventLimit=20");
                if (!cancelled && payload && payload.plan) setEvents(payload.plan.events || []);
              } catch {
                /* the journal is optional */
              }
            })();
            return () => {
              cancelled = true;
            };
          }, [props.plan.id]);
          const update = (field, value) => setForm(Object.assign({}, form, { [field]: value }));
          return h(
            "div",
            { style: S.drawer, role: "dialog", "aria-label": "Plan details" },
            h("h3", { style: S.laneTitle }, "Plan"),
            h(Field, { label: "Title" }, h("input", { style: S.input, value: form.title, onChange: (e) => update("title", e.target.value) })),
            h(
              Field,
              { label: "Description" },
              h("textarea", { style: S.textarea, value: form.description, onChange: (e) => update("description", e.target.value) }),
            ),
            h(Field, { label: "Status" }, h(Select, { value: form.status, options: PLAN_STATUSES, onChange: (value) => update("status", value) })),
            h(Field, { label: "Priority" }, h(Select, { value: form.priority, options: PRIORITIES, onChange: (value) => update("priority", value) })),
            h(Field, { label: "Tags (comma separated)" }, h("input", { style: S.input, value: form.tags, onChange: (e) => update("tags", e.target.value) })),
            props.plan.exportPath ? h("div", { style: S.muted }, "Exported: " + props.plan.exportPath) : null,
            h(
              "div",
              { style: S.row },
              h(
                "button",
                {
                  type: "button",
                  style: S.primary,
                  onClick: async () => {
                    const payload = await props.mutate("/api/plan/update", {
                      id: props.plan.id,
                      title: form.title,
                      description: form.description,
                      status: form.status,
                      priority: form.priority,
                      tags: form.tags
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter((tag) => tag.length > 0),
                    });
                    if (payload) props.onClose();
                  },
                },
                "Save",
              ),
              h(
                "button",
                {
                  type: "button",
                  style: S.danger,
                  onClick: async () => {
                    const payload = await props.mutate("/api/plan/purge", { id: props.plan.id, confirm: true });
                    if (payload) {
                      setData((previous) => ({
                        plans: previous.plans.filter((item) => item.id !== props.plan.id),
                        total: Math.max(0, previous.total - 1),
                        workspaces: previous.workspaces,
                      }));
                      props.onClose();
                    }
                  },
                },
                "Delete for good",
              ),
              h("div", { style: S.spacer }),
              h("button", { type: "button", style: S.button, onClick: props.onClose }, "Close"),
            ),
            h("div", { style: S.muted }, "Journal"),
            (events || []).slice(0, 10).map((event) =>
              h("div", { key: event.id, style: S.muted }, event.createdAt + " · " + event.kind + " · " + event.message),
            ),
          );
        }

        function TaskDrawer(props) {
          const [form, setForm] = React.useState({
            title: props.task.title,
            notes: props.task.notes || "",
            links: listToLines(props.task.links),
            status: props.task.status,
            phaseId: props.task.phaseId,
          });
          const update = (field, value) => setForm(Object.assign({}, form, { [field]: value }));
          const phases = props.plan.phases || [];
          return h(
            "div",
            { style: S.drawer, role: "dialog", "aria-label": "Task details" },
            h("h3", { style: S.laneTitle }, "Task"),
            h(Field, { label: "Title" }, h("input", { style: S.input, value: form.title, onChange: (e) => update("title", e.target.value) })),
            h(Field, { label: "Notes" }, h("textarea", { style: S.textarea, value: form.notes, onChange: (e) => update("notes", e.target.value) })),
            h(Field, { label: "Links (one per line)" }, h("textarea", { style: S.textarea, value: form.links, onChange: (e) => update("links", e.target.value) })),
            h(Field, { label: "Status" }, h(Select, { value: form.status, options: TASK_STATUSES, labels: TASK_STATUS_LABELS, onChange: (value) => update("status", value) })),
            h(
              Field,
              { label: "Phase" },
              h(Select, {
                value: form.phaseId,
                options: phases.map((phase) => phase.id),
                labels: phases.reduce((acc, phase) => Object.assign(acc, { [phase.id]: phase.title }), {}),
                onChange: (value) => update("phaseId", value),
              }),
            ),
            h(
              "div",
              { style: S.row },
              h(
                "button",
                {
                  type: "button",
                  style: S.primary,
                  onClick: async () => {
                    const payload = await props.mutate("/api/task/update", {
                      id: props.task.id,
                      title: form.title,
                      notes: form.notes,
                      links: linesToList(form.links),
                      status: form.status,
                      phaseId: form.phaseId,
                    });
                    if (payload) props.onSaved(payload.plan);
                  },
                },
                "Save",
              ),
              h(
                "button",
                {
                  type: "button",
                  style: S.danger,
                  onClick: async () => {
                    const payload = await props.mutate("/api/task/delete", { id: props.task.id });
                    if (payload) props.onSaved(payload.plan);
                  },
                },
                "Delete",
              ),
              h("div", { style: S.spacer }),
              h("button", { type: "button", style: S.button, onClick: props.onClose }, "Close"),
            ),
          );
        }

        /* ------------------------- modals ------------------------- */

        function renderModal(state) {
          if (state.kind === "plan") {
            return h(CreatePlanModal, { onCancel: () => setModal(null) });
          }
          if (state.kind === "phase") {
            return h(AddPhaseModal, { planId: state.planId, onCancel: () => setModal(null) });
          }
          return h(AddTaskModal, { planId: state.planId, phaseId: state.phaseId, onCancel: () => setModal(null) });
        }

        function CreatePlanModal(props) {
          const [form, setForm] = React.useState({ title: "", description: "", priority: "normal", workspace: "" });
          const update = (field, value) => setForm(Object.assign({}, form, { [field]: value }));
          const workspace = data.workspaces.find((item) => item.key === form.workspace) || null;
          return h(
            Modal,
            {
              title: "New plan",
              busy: busy,
              onCancel: props.onCancel,
              onSubmit: async () => {
                const payload = await mutate(
                  "/api/plan/create",
                  {
                    title: form.title,
                    description: form.description,
                    priority: form.priority,
                    workspace: form.workspace,
                    workspaceRoot: workspace ? workspace.path : "",
                  },
                  "Plan created",
                );
                if (payload) {
                  await load();
                  setModal(null);
                }
              },
            },
            h(Field, { label: "Title" }, h("input", { style: S.input, value: form.title, onChange: (e) => update("title", e.target.value) })),
            h(
              Field,
              { label: "Description" },
              h("textarea", { style: S.textarea, value: form.description, onChange: (e) => update("description", e.target.value) }),
            ),
            h(Field, { label: "Priority" }, h(Select, { value: form.priority, options: PRIORITIES, onChange: (value) => update("priority", value) })),
            h(
              Field,
              { label: "Workspace" },
              h(Select, {
                value: form.workspace,
                options: [""].concat(data.workspaces.map((item) => item.key)),
                labels: { "": "unbound" },
                onChange: (value) => update("workspace", value),
              }),
            ),
          );
        }

        function AddPhaseModal(props) {
          const [form, setForm] = React.useState({ title: "", notes: "", tasks: "" });
          const update = (field, value) => setForm(Object.assign({}, form, { [field]: value }));
          return h(
            Modal,
            {
              title: "New phase",
              busy: busy,
              onCancel: props.onCancel,
              onSubmit: async () => {
                const payload = await mutate(
                  "/api/phase/add",
                  { planId: props.planId, title: form.title, notes: form.notes, tasks: linesToList(form.tasks) },
                  "Phase added",
                );
                if (payload) setModal(null);
              },
            },
            h(Field, { label: "Title" }, h("input", { style: S.input, value: form.title, onChange: (e) => update("title", e.target.value) })),
            h(Field, { label: "Notes" }, h("textarea", { style: S.textarea, value: form.notes, onChange: (e) => update("notes", e.target.value) })),
            h(
              Field,
              { label: "Tasks (one per line)" },
              h("textarea", { style: S.textarea, value: form.tasks, onChange: (e) => update("tasks", e.target.value) }),
            ),
          );
        }

        function AddTaskModal(props) {
          const [form, setForm] = React.useState({ title: "", notes: "", links: "" });
          const update = (field, value) => setForm(Object.assign({}, form, { [field]: value }));
          return h(
            Modal,
            {
              title: "New task",
              busy: busy,
              onCancel: props.onCancel,
              onSubmit: async () => {
                const payload = await mutate(
                  "/api/task/add",
                  {
                    planId: props.planId,
                    phaseId: props.phaseId,
                    title: form.title,
                    notes: form.notes,
                    links: linesToList(form.links),
                  },
                  "Task added",
                );
                if (payload) setModal(null);
              },
            },
            h(Field, { label: "Title" }, h("input", { style: S.input, value: form.title, onChange: (e) => update("title", e.target.value) })),
            h(Field, { label: "Notes" }, h("textarea", { style: S.textarea, value: form.notes, onChange: (e) => update("notes", e.target.value) })),
            h(Field, { label: "Links (one per line)" }, h("textarea", { style: S.textarea, value: form.links, onChange: (e) => update("links", e.target.value) })),
          );
        }
      };
    }

    /* ------------------------------------------------------------------ *
     * goals & todos view (current session)
     * ------------------------------------------------------------------ */

    const TODO_CYCLE = { pending: "in_progress", in_progress: "completed", completed: "pending" };
    const TODO_LABELS = { pending: "to do", in_progress: "doing", completed: "done" };
    const GOAL_ACTIONS = [
      { action: "resume", label: "Resume" },
      { action: "pause", label: "Pause" },
      { action: "complete", label: "Complete" },
    ];

    function createGoalsView(ctx, scope) {
      return function GoalsTodos() {
        const [sessionId, setSessionId] = React.useState(() => currentSessionId(ctx));
        const [state, setState] = React.useState(null);
        const [candidates, setCandidates] = React.useState([]);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const [notice, setNotice] = React.useState("");
        const [draft, setDraft] = React.useState("");
        const [modal, setModal] = React.useState(null);

        React.useEffect(() => {
          const sync = () => setSessionId(currentSessionId(ctx));
          const unsubscribe = subscribeSessions(ctx, sync);
          sync();
          return () => {
            if (unsubscribe) unsubscribe();
          };
        }, []);

        const load = React.useCallback(async () => {
          setBusy(true);
          setError("");
          try {
            const query = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
            const payload = await apiGet(scope, "/api/session/state" + query);
            setState(payload.state || null);
            setCandidates(Array.isArray(payload.candidates) ? payload.candidates : []);
          } catch (loadError) {
            setError(errorText(loadError));
            setState(null);
          } finally {
            setBusy(false);
          }
        }, [sessionId]);

        React.useEffect(() => {
          load();
        }, [load]);

        React.useEffect(() => {
          const timer = window.setInterval(load, 15000);
          return () => window.clearInterval(timer);
        }, [load]);

        const goalAction = async (action, payload) => {
          if (!state) return;
          setBusy(true);
          setError("");
          try {
            const result = await apiPost(
              scope,
              "/api/session/goal",
              Object.assign({ sessionId: state.sessionId, action: action }, payload || {}),
            );
            setState(result.state || null);
            setNotice("Goal " + action + " applied.");
          } catch (actionError) {
            setError(errorText(actionError));
          } finally {
            setBusy(false);
          }
        };

        const saveTodos = async (todos, message) => {
          if (!state) return;
          setBusy(true);
          setError("");
          try {
            const result = await apiPost(scope, "/api/session/todos", { sessionId: state.sessionId, todos: todos });
            setState(result.state || null);
            setNotice(message || "Todo list saved.");
          } catch (saveError) {
            setError(errorText(saveError));
          } finally {
            setBusy(false);
          }
        };

        const archiveSession = async () => {
          if (!state) return;
          setBusy(true);
          setError("");
          try {
            const payload = await apiPost(scope, "/api/session/archive", { sessionId: state.sessionId });
            const count = typeof payload.count === "number" ? payload.count : 0;
            setNotice(
              (payload.sessionArchived ? "Session archived" : "This profile cannot archive the session itself") +
                " · plans archived: " +
                count +
                " — see the Plan Board tab.",
            );
          } catch (archiveError) {
            setError(errorText(archiveError));
          } finally {
            setBusy(false);
          }
        };

        const importPlan = async () => {
          if (!state) return;
          setBusy(true);
          setError("");
          try {
            const payload = await apiPost(scope, "/api/session/import", { sessionId: state.sessionId });
            setNotice(
              (payload.created ? "Created plan " : "Refreshed plan ") +
                (payload.plan ? payload.plan.id : "") +
                " — see the Plan Board tab.",
            );
          } catch (importError) {
            setError(errorText(importError));
          } finally {
            setBusy(false);
          }
        };

        const todos = state && Array.isArray(state.todos) ? state.todos : [];
        const goal = state ? state.goal : null;

        const cycle = (index) => {
          const next = todos.map((todo, position) =>
            position === index ? Object.assign({}, todo, { status: TODO_CYCLE[todo.status] || "pending" }) : todo,
          );
          saveTodos(next, "Todo status updated.");
        };

        const remove = (index) => saveTodos(todos.filter((_todo, position) => position !== index), "Todo removed.");

        const add = () => {
          const content = draft.trim();
          if (content.length === 0) return;
          saveTodos(todos.concat([{ content: content, status: "pending" }]), "Todo added.");
          setDraft("");
        };

        return h(
          "div",
          { style: S.root },
          h(
            "div",
            { style: S.toolbar },
            h("strong", { style: { fontSize: "12px" } }, "Goals & Todos"),
            h("span", { style: S.muted }, state ? state.sessionId : sessionId || "no session"),
            candidates.length > 1
              ? h(Select, {
                  value: state ? state.sessionId : "",
                  options: candidates,
                  onChange: (value) => setSessionId(value),
                })
              : null,
            h("div", { style: S.spacer }),
            h("span", { style: S.muted }, busy ? "working…" : ""),
            h("button", { type: "button", style: S.button, onClick: load, disabled: busy }, "Refresh"),
            h(
              "button",
              {
                type: "button",
                style: busy ? Object.assign({}, S.primary, S.disabled) : S.primary,
                disabled: busy || !state,
                onClick: importPlan,
                title: "Create or refresh the plan imported from this session",
              },
              "Import into plan",
            ),
            h(
              "button",
              {
                type: "button",
                style: S.danger,
                disabled: busy || !state,
                onClick: archiveSession,
                title: "Archive this dsh session; its plans are archived with it",
              },
              "Archive session",
            ),
          ),
          error ? h("div", { style: Object.assign({}, S.banner, S.error) }, error) : null,
          notice ? h("div", { style: S.banner }, notice) : null,
          h(
            "div",
            { style: S.board },
            goal
              ? h(
                  "div",
                  { style: S.lane },
                  h(
                    "div",
                    { style: S.laneHead },
                    h("h3", { style: S.laneTitle }, goal.objective || "(goal without objective)"),
                    h("span", { style: S.badge }, goal.phase),
                    goal.activation ? h("span", { style: S.muted }, goal.activation) : null,
                    h("span", { style: S.muted }, "rounds " + goal.roundsStarted + "/" + goal.maxGoalRounds),
                    h("div", { style: S.spacer }),
                    GOAL_ACTIONS.map((entry) =>
                      h(
                        "button",
                        {
                          key: entry.action,
                          type: "button",
                          style: S.button,
                          disabled: busy,
                          onClick: () => goalAction(entry.action),
                        },
                        entry.label,
                      ),
                    ),
                    h(
                      "button",
                      { type: "button", style: S.button, disabled: busy, onClick: () => setModal({ kind: "goal" }) },
                      "Edit",
                    ),
                    h(
                      "button",
                      { type: "button", style: S.danger, disabled: busy, onClick: () => setModal({ kind: "block" }) },
                      "Block",
                    ),
                  ),
                  goal.blockedReason
                    ? h(
                        "div",
                        { style: S.phase },
                        h("span", { style: S.muted }, "blocked: " + goal.blockedReason.code + " — " + goal.blockedReason.message),
                      )
                    : null,
                )
              : h("div", { style: S.lane }, h("div", { style: S.laneHead }, h("span", { style: S.muted }, "This session has no goal."))),
            h(
              "div",
              { style: S.lane },
              h(
                "div",
                { style: S.laneHead },
                h("h3", { style: S.laneTitle }, "Todos"),
                h("span", { style: S.muted }, todos.filter((todo) => todo.status === "completed").length + "/" + todos.length + " done"),
                state && state.todosSource === "log"
                  ? h("span", { style: S.muted }, "· read from the session log (stale projection)")
                  : null,
              ),
              h(
                "div",
                { style: S.phase },
                todos.length === 0 ? h("div", { style: S.muted }, "No todo items in this session.") : null,
                todos.map((todo, index) =>
                  h(
                    "div",
                    { key: index, style: Object.assign({}, S.card, todo.status === "completed" ? S.cardDone : {}) },
                    h(
                      "div",
                      { style: S.row },
                      h(
                        "button",
                        {
                          type: "button",
                          style: Object.assign({}, S.button, { minWidth: "74px" }),
                          disabled: busy,
                          onClick: () => cycle(index),
                          title: "Cycle the status",
                        },
                        TODO_LABELS[todo.status] || todo.status,
                      ),
                      h("span", { style: { flex: "1 1 auto" } }, todo.content),
                      h(
                        "button",
                        { type: "button", style: S.danger, disabled: busy, onClick: () => remove(index) },
                        "×",
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { style: Object.assign({}, S.row, { marginTop: "6px" }) },
                  h("input", {
                    style: Object.assign({}, S.input, { flex: "1 1 auto" }),
                    placeholder: "New todo…",
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === "Enter") add();
                    },
                  }),
                  h(
                    "button",
                    { type: "button", style: S.primary, disabled: busy || !state, onClick: add },
                    "Add",
                  ),
                ),
              ),
            ),
          ),
          modal ? renderGoalModal() : null,
        );

        function renderGoalModal() {
          if (modal.kind === "block") {
            return h(BlockModal, { onCancel: () => setModal(null), onSubmit: (reason) => { setModal(null); goalAction("block", { reason: reason }); } });
          }
          return h(EditGoalModal, {
            goal: goal,
            onCancel: () => setModal(null),
            onSubmit: (objective, rounds) => {
              setModal(null);
              goalAction("edit", { objective: objective, maxGoalRounds: rounds });
            },
          });
        }

        function EditGoalModal(props) {
          const [objective, setObjective] = React.useState(props.goal ? props.goal.objective : "");
          const [rounds, setRounds] = React.useState(props.goal ? props.goal.maxGoalRounds : 10);
          return h(
            Modal,
            {
              title: "Edit goal",
              submitLabel: "Save",
              onCancel: props.onCancel,
              onSubmit: () => props.onSubmit(objective, Number(rounds) || undefined),
            },
            h(Field, { label: "Objective" }, h("input", { style: S.input, value: objective, onChange: (e) => setObjective(e.target.value) })),
            h(Field, { label: "Max goal rounds" }, h("input", { style: S.input, type: "number", min: "1", value: rounds, onChange: (e) => setRounds(e.target.value) })),
          );
        }

        function BlockModal(props) {
          const [reason, setReason] = React.useState("Blocked from the plan board.");
          return h(
            Modal,
            {
              title: "Block goal",
              submitLabel: "Block",
              onCancel: props.onCancel,
              onSubmit: () => props.onSubmit(reason),
            },
            h(Field, { label: "Reason" }, h("textarea", { style: S.textarea, value: reason, onChange: (e) => setReason(e.target.value) })),
          );
        }
      };
    }

    /* ------------------------------------------------------------------ *
     * settings card
     * ------------------------------------------------------------------ */

    function createSettingsCard(scope) {
      return function SettingsCard() {
        const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
        const [form, setForm] = React.useState(() => toSettingsForm(snapshot.value));
        const [notice, setNotice] = React.useState("");
        const [busy, setBusy] = React.useState(false);

        React.useEffect(() => {
          const onChange = () => setSnapshot(scope.getSnapshot());
          let unsubscribe = null;
          try {
            unsubscribe = scope.subscribe(onChange);
          } catch {
            unsubscribe = null;
          }
          onChange();
          return () => {
            if (unsubscribe) unsubscribe();
          };
        }, []);

        React.useEffect(() => {
          setForm(toSettingsForm(snapshot.value));
        }, [snapshot.status, snapshot.revision]);

        const update = (field, value) => setForm((previous) => Object.assign({}, previous, { [field]: value }));

        const save = async () => {
          setBusy(true);
          setNotice("Saving settings…");
          try {
            await scope.set("storageRoot", String(form.storageRoot || ""));
            await scope.set("webPath", String(form.webPath || DEFAULT_WEB_PATH));
            await scope.set("exportDir", String(form.exportDir || ".dsh/plans"));
            await scope.set("autoExport", !!form.autoExport);
            await scope.set("promptActivePlans", !!form.promptActivePlans);
            await scope.set("promptActiveLimit", Number(form.promptActiveLimit) || 0);
            await scope.set("stalePlanDays", Number(form.stalePlanDays) || 14);
            await scope.set("systemPrompt", String(form.systemPrompt || ""));
            setNotice("Saved. The storage root needs a plugin restart; everything else applies immediately.");
          } catch {
            setNotice("Save failed: " + errorText(error));
          } finally {
            setBusy(false);
          }
        };

        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "10px", padding: "12px" } },
          h("h3", { style: S.laneTitle }, "Plan store"),
          h(
            "p",
            { style: S.muted },
            "Plans live in a SQLite database; the kanban board renders them as swimlanes and task status columns.",
          ),
          h(Field, { label: "Storage root (empty = $DSH_HOME/plan-store)" }, h("input", { style: S.input, value: form.storageRoot, onChange: (e) => update("storageRoot", e.target.value) })),
          h(Field, { label: "Web path" }, h("input", { style: S.input, value: form.webPath, onChange: (e) => update("webPath", e.target.value) })),
          h(Field, { label: "Export directory" }, h("input", { style: S.input, value: form.exportDir, onChange: (e) => update("exportDir", e.target.value) })),
          h(
            "label",
            { style: Object.assign({}, S.muted, { display: "flex", gap: "6px", alignItems: "center" }) },
            h("input", { type: "checkbox", checked: !!form.autoExport, onChange: (e) => update("autoExport", e.target.checked) }),
            "Remind the agent to export plans after changes",
          ),
          h(
            "label",
            { style: Object.assign({}, S.muted, { display: "flex", gap: "6px", alignItems: "center" }) },
            h("input", {
              type: "checkbox",
              checked: !!form.promptActivePlans,
              onChange: (e) => update("promptActivePlans", e.target.checked),
            }),
            "Show active plans in the system prompt",
          ),
          h(Field, { label: "Prompt plan limit" }, h("input", { style: S.input, type: "number", min: "0", max: "20", value: form.promptActiveLimit, onChange: (e) => update("promptActiveLimit", e.target.value) })),
          h(Field, { label: "Stale plan days" }, h("input", { style: S.input, type: "number", min: "1", value: form.stalePlanDays, onChange: (e) => update("stalePlanDays", e.target.value) })),
          h(Field, { label: "System prompt" }, h("textarea", { style: Object.assign({}, S.textarea, { minHeight: "140px" }), value: form.systemPrompt, onChange: (e) => update("systemPrompt", e.target.value) })),
          h(
            "div",
            { style: S.row },
            h(
              "button",
              { type: "button", style: busy ? Object.assign({}, S.primary, S.disabled) : S.primary, disabled: busy, onClick: save },
              "Save",
            ),
            notice ? h("span", { style: S.muted }, notice) : null,
          ),
        );
      };
    }

    function toSettingsForm(value) {
      const source = value && typeof value === "object" ? value : {};
      return {
        storageRoot: typeof source.storageRoot === "string" ? source.storageRoot : "",
        webPath: typeof source.webPath === "string" ? source.webPath : DEFAULT_WEB_PATH,
        exportDir: typeof source.exportDir === "string" ? source.exportDir : ".dsh/plans",
        autoExport: source.autoExport !== false,
        promptActivePlans: source.promptActivePlans !== false,
        promptActiveLimit: typeof source.promptActiveLimit === "number" ? source.promptActiveLimit : 5,
        stalePlanDays: typeof source.stalePlanDays === "number" ? source.stalePlanDays : 14,
        systemPrompt: typeof source.systemPrompt === "string" ? source.systemPrompt : "",
      };
    }

    /* ------------------------------------------------------------------ *
     * plugin entry
     * ------------------------------------------------------------------ */

    function apply(rawContext) {
      const ctx = rawContext;
      let scope = null;
      try {
        scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      } catch {
        scope = null;
      }
      if (!scope) {
        scope = {
          getSnapshot: () => ({ value: { webPath: DEFAULT_WEB_PATH }, status: "unavailable", revision: 0 }),
          subscribe: () => () => {},
          set: async () => {},
        };
      }

      const PlanBoard = createBoardView(ctx, scope);
      const GoalsTodos = createGoalsView(ctx, scope);
      const SettingsCard = createSettingsCard(scope);

      ctx.slots.inject("conversation.view", () => {
        ctx.slots.register({ name: "conversation.view", id: VIEW_ID, order: ORDER, label: () => VIEW_LABEL }, PlanBoard);
        ctx.slots.register(
          { name: "conversation.view", id: GOALS_ID, order: ORDER + 1, label: () => GOALS_LABEL },
          GoalsTodos,
        );
      });

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: VIEW_ID, order: 40, label: () => VIEW_LABEL }, SettingsCard),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "settingsScope", "sessions"];
    return module.exports;
  },
});
