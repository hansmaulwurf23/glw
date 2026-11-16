const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Util = imports.misc.util;

const STATUS_LABEL = {
    created: "created",
    waiting_for_resource: "waiting for resource",
    preparing: "preparing",
    pending: "pending",
    running: "running",
    scheduled: "scheduled",
    manual: "waiting for manual job",
    success: "passed",
    failed: "failed",
    canceled: "canceled",
    skipped: "skipped",
};

function ago(iso) {
    if (!iso) return "";
    let secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (secs < 60) return secs + "s";
    let mins = Math.floor(secs / 60);
    if (mins < 60) return mins + " min";
    let h = Math.floor(mins / 60);
    if (h < 24) return h + " h " + (mins % 60) + " min";
    return Math.floor(h / 24) + " d";
}

class GlwApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this._timer = 0;
        this._blinkTimer = 0;
        this._blinkOn = false;
        this._running = false;
        this._destroyed = false;
        this._data = null;
        this._prevBusy = null; // Map key -> entry (null = first run)

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        for (let [key, prop] of [["hosts", "hosts"], ["activity-days", "activityDays"],
                                 ["recent-minutes", "recentMinutes"], ["interval-idle", "intervalIdle"],
                                 ["interval-busy", "intervalBusy"], ["show-count", "showCount"],
                                 ["animate", "animate"], ["notify", "notify"]]) {
            this.settings.bind(key, prop, () => this._onSettingsChanged());
        }

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._setIcon("glw-idle");
        this.set_applet_label("");
        this.set_applet_tooltip("GitLab Pipelines: loading …");
        this._buildMenu();
        this._refresh();
    }

    // ---------- Helpers ----------

    _iconPath(name) {
        return this.metadata.path + "/icons/" + name + ".svg";
    }

    _setIcon(name) {
        if (this._iconName === name) return;
        this._iconName = name;
        this.set_applet_icon_path(this._iconPath(name));
    }

    _openUrl(url) {
        if (url) Gio.AppInfo.launch_default_for_uri(url, null);
    }

    _key(e) {
        return e.host + "#" + e.id;
    }

    // ---------- Polling ----------

    _onSettingsChanged() {
        this._schedule(1);
    }

    _schedule(seconds) {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._destroyed) return;
        this._timer = Mainloop.timeout_add_seconds(seconds, () => {
            this._timer = 0;
            this._refresh();
            return false;
        });
    }

    _refresh() {
        if (this._running || this._destroyed) return;
        this._running = true;
        let argv = ["python3", this.metadata.path + "/glw-status.py",
                    "--hosts", this.hosts || "",
                    "--activity-days", String(this.activityDays),
                    "--recent-minutes", String(this.recentMinutes)];
        try {
            let proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                this._running = false;
                if (this._destroyed) return;
                let data = null, err = null;
                try {
                    let [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (p.get_successful()) data = JSON.parse(stdout);
                    else err = (stderr || "").trim().split("\n").pop() || "status helper failed";
                } catch (e) {
                    err = String(e);
                }
                this._update(data, err);
            });
        } catch (e) {
            this._running = false;
            this._update(null, String(e));
        }
    }

    // ---------- State ----------

    _update(data, err) {
        this._data = data;
        this._error = err;

        let busy = data ? data.busy : [];
        let ready = data ? data.ready : [];
        let recent = data ? data.recent : [];
        let hostErrors = data ? data.hosts.filter(h => h.error) : [];

        if (data) this._notifyFinished(busy, recent, ready);

        // Icon
        let icon;
        if (err && !data) icon = "glw-error";
        else if (busy.length) icon = "glw-running";
        else if (ready.length) icon = "glw-ready";
        else if (recent.length && recent[0].status === "failed") icon = "glw-failed";
        else if (recent.length && recent[0].status === "success") icon = "glw-success";
        else if (hostErrors.some(h => !h.skipped)) icon = "glw-error";
        else icon = "glw-idle";
        this._baseIcon = icon;
        this._setIcon(icon);
        this._updateBlink(busy.length > 0);

        this.set_applet_label(this.showCount && busy.length ? String(busy.length) : "");

        // Tooltip
        let tip;
        if (err && !data) tip = "GitLab Pipelines: error\n" + err;
        else if (busy.length)
            tip = busy.length + " pipeline(s) running – do not deploy yet\n" +
                  busy.map(e => "• " + e.project + " (" + e.ref + ") " + (STATUS_LABEL[e.status] || e.status)).join("\n");
        else if (ready.length) tip = "Pipelines done, " + ready.length + " waiting for a manual job (deploy?)";
        else tip = "No running pipelines – ready to deploy";
        if (hostErrors.length)
            tip += "\n\n" + hostErrors.map(h => "⚠ " + h.host + ": " + h.error).join("\n");
        this.set_applet_tooltip(tip);

        this._buildMenu();
        this._schedule(busy.length ? this.intervalBusy : this.intervalIdle);
    }

    _notifyFinished(busy, recent, ready) {
        let nowBusy = new Map(busy.map(e => [this._key(e), e]));
        if (this._prevBusy && this.notify) {
            let done = new Map(recent.concat(ready).map(e => [this._key(e), e]));
            for (let [key, old] of this._prevBusy) {
                if (nowBusy.has(key)) continue;
                let e = done.get(key) || old;
                let status = done.has(key) ? e.status : "finished";
                let icon = e.status === "failed" ? "glw-failed"
                         : e.status === "manual" ? "glw-ready"
                         : e.status === "success" ? "glw-success" : "glw-idle";
                Util.spawn(["notify-send", "-a", "GitLab Pipeline Watch", "-i", this._iconPath(icon),
                            e.project + " (" + e.ref + ")",
                            "Pipeline #" + e.id + ": " + (STATUS_LABEL[status] || status) +
                            (nowBusy.size ? "" : "\nAll pipelines done – you can deploy now.")]);
            }
        }
        this._prevBusy = nowBusy;
    }

    _updateBlink(on) {
        let want = on && this.animate;
        if (want && !this._blinkTimer) {
            this._blinkTimer = Mainloop.timeout_add(700, () => {
                if (this._baseIcon !== "glw-running") {
                    this._blinkTimer = 0;
                    return false;
                }
                this._blinkOn = !this._blinkOn;
                this._setIcon(this._blinkOn ? "glw-running2" : "glw-running");
                return true;
            });
        } else if (!want && this._blinkTimer) {
            Mainloop.source_remove(this._blinkTimer);
            this._blinkTimer = 0;
        }
    }

    // ---------- Menu ----------

    _addPipelineItem(e) {
        let label = e.project + "  ·  " + e.ref + "  ·  " + (STATUS_LABEL[e.status] || e.status) +
                    "  (" + ago(e.created_at) + ")";
        let iconName = e.status === "failed" ? "dialog-error-symbolic"
                     : e.status === "success" ? "emblem-ok-symbolic"
                     : e.status === "manual" ? "media-playback-start-symbolic"
                     : e.status === "canceled" || e.status === "skipped" ? "process-stop-symbolic"
                     : "emblem-synchronizing-symbolic";
        let item = new PopupMenu.PopupIconMenuItem(label, iconName, 1 /* St.IconType.SYMBOLIC */);
        item.connect("activate", () => this._openUrl(e.url));
        this.menu.addMenuItem(item);
    }

    _addSection(title, entries) {
        if (!entries.length) return;
        let header = new PopupMenu.PopupMenuItem(title, { reactive: false });
        header.label.set_style("font-weight: bold;");
        this.menu.addMenuItem(header);
        entries.forEach(e => this._addPipelineItem(e));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildMenu() {
        this.menu.removeAll();
        let d = this._data;

        if (this._error && !d) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("Error: " + this._error, { reactive: false }));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else if (d) {
            if (!d.busy.length)
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem("✔ No running pipelines", { reactive: false }));
            this._addSection("Running", d.busy);
            this._addSection("Waiting for manual job", d.ready);
            this._addSection("Recently finished", d.recent);
            if (!d.busy.length && !d.ready.length && !d.recent.length)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (let h of d.hosts) {
                let txt = h.error ? "⚠ " + h.host + ": " + h.error
                                  : h.host + ": " + h.projects + " active projects";
                let item = new PopupMenu.PopupMenuItem(txt);
                item.connect("activate", () => this._openUrl("https://" + h.host + "/dashboard/projects"));
                this.menu.addMenuItem(item);
            }
            let ts = new Date(Date.parse(d.generated_at)).toLocaleTimeString();
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("Updated: " + ts, { reactive: false }));
        } else {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("Loading …", { reactive: false }));
        }

        let refresh = new PopupMenu.PopupIconMenuItem("Refresh now", "view-refresh-symbolic", 1);
        refresh.connect("activate", () => this._schedule(0));
        this.menu.addMenuItem(refresh);
    }

    // ---------- Applet API ----------

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        this._schedule(0);
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        if (this._timer) Mainloop.source_remove(this._timer);
        if (this._blinkTimer) Mainloop.source_remove(this._blinkTimer);
        this._timer = this._blinkTimer = 0;
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new GlwApplet(metadata, orientation, panelHeight, instanceId);
}
