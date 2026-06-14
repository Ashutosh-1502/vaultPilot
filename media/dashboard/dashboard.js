/* ============================================================================
 * VaultPilot Dashboard — Webview Script
 *
 * Vanilla JS, no bundler. Organized in clearly-marked sections:
 *   1. STATE      — local view-model
 *   2. API        — message passing to/from the extension
 *   3. ROUTING    — switching between Dashboard / Project / Settings views
 *   4. DASHBOARD  — render project grid + stats + filters
 *   5. PROJECT    — render meta block + credentials list
 *   6. SETTINGS   — render Drive + health + version
 *   7. COMPONENTS — small renderers (project-card, credential-card)
 *   8. INIT       — wire DOM listeners, request initial state
 *
 * No third-party deps. Uses VS Code's `acquireVsCodeApi()` for messaging.
 * ========================================================================= */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ─── 0. ICONS ──────────────────────────────────────────────────────
  // Inline SVG line icons (1.5pt stroke per DESIGN.md §Iconography).
  // Each entry returns an SVG string. Optional `cls` adds an extra class
  // to the root <svg> (e.g. vp-icon-sm / vp-icon-lg).
  function icon(name, cls) {
    const c = 'vp-icon' + (cls ? ' ' + cls : '');
    const svgs = {
      shield:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z"/></svg>',
      cloud:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.7-7.94 5 5 0 0 1 9.78-1.13A4.5 4.5 0 0 1 17 18z"/></svg>',
      lock:
        '<svg class="' + c + '" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
      unlock:
        '<svg class="' + c + '" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-3"/></svg>',
      key:
        '<svg class="' + c + '" viewBox="0 0 24 24"><circle cx="7" cy="14" r="3.5"/><path d="M10 14h11"/><path d="M18 14v3"/><path d="M21 14v2"/></svg>',
      refresh:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
      search:
        '<svg class="' + c + '" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
      trash:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
      archive:
        '<svg class="' + c + '" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/></svg>',
      download:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
      eye:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      'eye-off':
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7c2.4 0 4.4.9 6 2"/><path d="M22 12s-4 7-10 7c-2.4 0-4.4-.9-6-2"/><path d="M3 3l18 18"/><path d="M9.5 9.5a3 3 0 0 0 4 4"/></svg>',
      copy:
        '<svg class="' + c + '" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
      edit:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16v4z"/></svg>',
      plus:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M12 4v16"/><path d="M4 12h16"/></svg>',
      check:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M5 13l5 5L20 7"/></svg>',
      x:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
      gear:
        '<svg class="' + c + '" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8L4.2 7a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
      link:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
      folder:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
      info:
        '<svg class="' + c + '" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01"/><path d="M11 12h1v5"/></svg>',
      alert:
        '<svg class="' + c + '" viewBox="0 0 24 24"><path d="M12 3L2 21h20L12 3z"/><path d="M12 10v4"/><path d="M12 17v.01"/></svg>',
      'archive-restore':
        '<svg class="' + c + '" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M12 19v-7"/><path d="M9 15l3-3 3 3"/></svg>',
    };
    return svgs[name] || '';
  }

  // ─── 1. STATE ──────────────────────────────────────────────────────
  const state = {
    currentView: 'dashboard',
    projects: [],
    currentProject: null,
    currentCredentials: [],
    revealed: {}, // credentialId → true if revealed
    filter: { search: '', tab: 'all', sort: 'recent' },
    settings: {
      driveBackupEnabled: false,
      driveLastBackupAt: null,
      vaultRoot: '~/.vaultpilot/',
      version: '0.0.1',
      autoLockOnIdle: true,
    },
    /**
     * Tracks whether we have evidence that the Drive backup file is absent.
     * Set true on: live-refresh returning "no file", remove-backup success.
     * Cleared (false) on: settings-loaded with non-null driveLastBackup,
     * live-refresh returning a file.
     * Used to hide Inspect / Remove buttons and detail rows when we know
     * there's nothing in Drive to inspect or remove.
     */
    knownBackupAbsent: false,
  };

  // ─── 2. API (extension <-> webview messages) ───────────────────────
  function send(msg) {
    vscode.postMessage(msg);
  }
  function listProjects() { send({ kind: 'list-projects' }); }
  function loadProject(fingerprint) { send({ kind: 'load-project', fingerprint }); }
  function unlockProject(fingerprint) { send({ kind: 'unlock-project', fingerprint }); }
  function inlineCopy(credentialId, fingerprint) { send({ kind: 'copy', credentialId, fingerprint }); }
  function inlineReveal(credentialId, fingerprint) { send({ kind: 'reveal', credentialId, fingerprint }); }
  function inlineEdit(credentialId, fingerprint) { send({ kind: 'edit', credentialId, fingerprint }); }
  function inlineDelete(credentialId, fingerprint) { send({ kind: 'delete', credentialId, fingerprint }); }
  function addCredential(fingerprint) { send({ kind: 'add-credential', fingerprint }); }
  function createNewVault() { send({ kind: 'create-new-vault' }); }
  function syncToDrive() { send({ kind: 'sync-to-drive' }); }
  function removeDriveBackup() { send({ kind: 'remove-drive-backup' }); }
  function refreshDriveBackup() { send({ kind: 'refresh-drive-backup' }); }
  function inspectDriveBackup() { send({ kind: 'inspect-drive-backup' }); }
  function downloadEnv(fingerprint) { send({ kind: 'download-env', fingerprint: fingerprint }); }
  function localBackup() { send({ kind: 'local-backup' }); }
  function refreshLocalBackup() { send({ kind: 'refresh-local-backup' }); }
  function inspectLocalBackup() { send({ kind: 'inspect-local-backup' }); }
  function revealLocalVault(fingerprint, status) {
    send({ kind: 'reveal-local-vault', fingerprint: fingerprint, status: status });
  }
  function archiveProject(fingerprint, displayName) {
    send({ kind: 'archive-project', fingerprint: fingerprint, displayName: displayName });
  }
  function unarchiveProject(fingerprint, displayName) {
    send({ kind: 'unarchive-project', fingerprint: fingerprint, displayName: displayName });
  }
  function deleteArchived(fingerprint, displayName) {
    send({ kind: 'delete-archived', fingerprint: fingerprint, displayName: displayName });
  }
  function openVaultSettings() { send({ kind: 'open-vscode-settings' }); }
  function openDocsLink(target) { send({ kind: 'open-docs', target }); }
  function loadSettings() { send({ kind: 'load-settings' }); }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.kind) return;
    switch (msg.kind) {
      case 'projects-loaded':
        state.projects = msg.projects;
        renderDashboard();
        break;
      case 'project-loaded':
        state.currentCredentials = msg.credentials;
        renderProjectView();
        break;
      case 'project-needs-unlock':
        renderUnlockPrompt(msg.fingerprint);
        break;
      case 'settings-loaded':
        Object.assign(state.settings, msg.settings);
        // If we now have backup info, any previous "absent" signal is stale.
        // If we don't, leave knownBackupAbsent as-is (it may have been
        // explicitly set to true by remove-success or live-refresh).
        if (msg.settings && msg.settings.driveLastBackup) {
          state.knownBackupAbsent = false;
        }
        if (state.currentView === 'settings') renderSettings();
        renderStats();
        break;
      case 'changed':
        // Triggered after add/edit/delete OR after a successful sync — refresh data.
        listProjects();
        loadSettings();
        if (state.currentProject) loadProject(state.currentProject.fingerprint);
        break;
      case 'drive-backup-info':
        renderDriveBackupLive(msg.info, msg.error);
        break;
      case 'drive-backup-contents':
        renderDriveBackupContents(msg.inspection, msg.error);
        break;
      case 'local-backup-vaults':
        renderLocalBackupVaults(msg.vaults, msg.folder, msg.error);
        break;
      case 'reveal-result':
        if (msg.value !== undefined) flashReveal(msg.credentialId, msg.value);
        break;
    }
  });

  // ─── 3. ROUTING ────────────────────────────────────────────────────
  function navigate(view, params) {
    state.currentView = view;
    document.querySelectorAll('.view').forEach((el) => { el.hidden = true; });
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
    });
    const target = document.getElementById('view-' + view);
    if (target) target.hidden = false;

    if (view === 'dashboard') {
      renderDashboard();
    } else if (view === 'project' && params && params.project) {
      state.currentProject = params.project;
      state.currentCredentials = [];
      renderProjectView();
      loadProject(params.project.fingerprint);
    } else if (view === 'settings') {
      loadSettings();
      renderSettings();
    }
  }

  // ─── 4. DASHBOARD VIEW ─────────────────────────────────────────────
  function renderDashboard() {
    const grid = document.getElementById('project-grid');
    const empty = document.getElementById('empty-state');
    if (!grid) return;

    const visible = filterAndSort(state.projects, state.filter);

    if (visible.length === 0 && state.projects.length === 0) {
      grid.innerHTML = '';
      grid.appendChild(renderCreateVaultCard());
      empty.hidden = true;
    } else if (visible.length === 0) {
      grid.innerHTML = '';
      empty.hidden = false;
    } else {
      empty.hidden = true;
      grid.innerHTML = '';
      visible.forEach((p) => grid.appendChild(renderProjectCard(p)));
      grid.appendChild(renderCreateVaultCard());
    }
    renderStats();
  }

  function filterAndSort(projects, f) {
    let out = projects.slice();
    if (f.tab !== 'all') out = out.filter((p) => p.status === f.tab);
    if (f.search.trim().length > 0) {
      const q = f.search.toLowerCase();
      out = out.filter((p) => {
        return (
          (p.displayName || '').toLowerCase().includes(q) ||
          (p.gitRemoteUrl || '').toLowerCase().includes(q) ||
          (p.lastKnownPath || '').toLowerCase().includes(q)
        );
      });
    }
    if (f.sort === 'name') {
      out.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    } else if (f.sort === 'created') {
      out.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    }
    // 'recent' = default order returned by extension (modification time)
    return out;
  }

  function renderStats() {
    const secretsEl = document.getElementById('stat-secrets');
    const activeEl = document.getElementById('stat-active');
    const syncEl = document.getElementById('stat-sync');
    const syncDelta = document.getElementById('stat-sync-delta');
    if (!secretsEl) return;

    const knownCounts = state.projects.filter((p) => typeof p.knownCount === 'number');
    if (knownCounts.length === 0) {
      secretsEl.textContent = '?';
    } else {
      const total = knownCounts.reduce((s, p) => s + p.knownCount, 0);
      secretsEl.textContent = String(total);
    }

    const activeProjects = state.projects.filter((p) => p.status === 'active').length;
    activeEl.textContent = String(activeProjects);

    if (!state.settings.driveBackupEnabled) {
      syncEl.textContent = '—';
      syncDelta.textContent = 'Drive backup disabled';
    } else if (state.settings.driveLastBackupAt) {
      const ageMs = Date.now() - new Date(state.settings.driveLastBackupAt).getTime();
      const days = Math.floor(ageMs / 86400000);
      if (days < 7) {
        syncEl.textContent = '100%';
        syncDelta.textContent = days === 0 ? 'Backed up today' : days + 'd ago';
      } else {
        syncEl.textContent = 'Stale';
        syncDelta.textContent = days + 'd since last backup';
      }
    } else {
      syncEl.textContent = '0%';
      syncDelta.textContent = 'No backup yet';
    }
  }

  // ─── 5. PROJECT VIEW ───────────────────────────────────────────────
  function renderProjectView() {
    const p = state.currentProject;
    if (!p) return;
    document.getElementById('project-title').textContent = p.displayName || p.fingerprint;
    const meta = document.getElementById('project-meta');
    meta.innerHTML = '';
    meta.appendChild(metaRow('GIT REMOTE', p.gitRemoteUrl || '(no remote — fingerprinted by path)'));
    meta.appendChild(metaRow('FINGERPRINT', p.fingerprint));
    meta.appendChild(metaRow('LOCAL PATH', p.lastKnownPath || '(unknown)'));
    meta.appendChild(metaRow('STATUS', p.status.toUpperCase()));

    const list = document.getElementById('credentials-list');
    const count = document.getElementById('credentials-count');
    list.innerHTML = '';
    count.textContent = String(state.currentCredentials.length) + ' ENTRIES';
    state.currentCredentials.forEach((c) => list.appendChild(renderCredentialCard(c, p.fingerprint)));
  }

  function renderUnlockPrompt(fingerprint) {
    const list = document.getElementById('credentials-list');
    const count = document.getElementById('credentials-count');
    list.innerHTML = '';
    count.textContent = 'LOCKED';
    const div = document.createElement('div');
    div.className = 'unlock-prompt';
    div.innerHTML = '<div class="lock-icon">' + icon('lock', 'vp-icon-lg') + '</div>' +
      '<div class="msg">This vault is locked. Enter your passphrase to view its credentials.</div>';
    const btn = document.createElement('button');
    btn.textContent = 'Unlock Vault';
    btn.addEventListener('click', () => unlockProject(fingerprint));
    div.appendChild(btn);
    list.appendChild(div);
  }

  function flashReveal(credentialId, value) {
    const input = document.querySelector('[data-cred-value="' + credentialId + '"]');
    if (!input) return;
    input.value = value;
    input.classList.add('revealed');
    setTimeout(() => {
      input.value = '••••••••';
      input.classList.remove('revealed');
    }, 6000);
  }

  // ─── 6. SETTINGS VIEW ──────────────────────────────────────────────
  function renderSettings() {
    // Drive Sync section is now read-only "Coming Soon" — skip Drive UI updates
    // entirely (the elements no longer exist). All Drive-specific rendering
    // below uses optional-chaining guards so missing nodes are tolerated.
    const lb = state.settings.driveLastBackup;
    const fileExists = !!lb && !state.knownBackupAbsent;

    const sizeRow = document.getElementById('drive-size-row');
    const nameRow = document.getElementById('drive-name-row');
    const md5Row = document.getElementById('drive-md5-row');
    const idRow = document.getElementById('drive-fileid-row');
    const modifiedRow = document.getElementById('drive-modified-row');
    if (fileExists) {
      if (sizeRow) sizeRow.hidden = false;
      if (nameRow) nameRow.hidden = false;
      if (md5Row) md5Row.hidden = false;
      if (idRow) idRow.hidden = false;
      const sizeEl = document.getElementById('drive-backup-size');
      const nameEl = document.getElementById('drive-backup-name');
      const md5El = document.getElementById('drive-backup-md5');
      const idEl = document.getElementById('drive-backup-fileid');
      if (sizeEl) sizeEl.textContent = formatBytes(lb.bytes);
      if (nameEl) nameEl.textContent = lb.fileName;
      if (md5El) md5El.textContent = lb.md5;
      if (idEl) idEl.textContent = lb.fileId;
    } else {
      if (sizeRow) sizeRow.hidden = true;
      if (nameRow) nameRow.hidden = true;
      if (md5Row) md5Row.hidden = true;
      if (idRow) idRow.hidden = true;
      if (modifiedRow) modifiedRow.hidden = true;
    }

    // Inspect Backup + Remove from Drive — only useful if there IS a file.
    const inspectBtn = document.getElementById('inspect-drive-btn');
    const removeBtn = document.getElementById('remove-drive-btn');
    if (inspectBtn) inspectBtn.hidden = !fileExists;
    if (removeBtn) removeBtn.hidden = !fileExists;

    // Local backup state
    const localInfo = state.settings.localLastBackup;
    const localLastEl = document.getElementById('local-last-backup');
    const localFolderRow = document.getElementById('local-folder-row');
    const localCountRow = document.getElementById('local-count-row');
    const destLocalSub = document.getElementById('dest-local-sub');
    const refreshLocalBtn = document.getElementById('refresh-local-btn');
    if (localInfo) {
      localLastEl.textContent = new Date(localInfo.uploadedAt).toLocaleString();
      localFolderRow.hidden = false;
      localCountRow.hidden = false;
      document.getElementById('local-backup-folder').textContent = localInfo.folder;
      const total = localInfo.projectsCopied + localInfo.archivedCopied;
      document.getElementById('local-backup-count').textContent =
        total + ' (' + localInfo.projectsCopied + ' active, ' + localInfo.archivedCopied + ' archived) — ' +
        formatBytes(localInfo.bytes);
      if (destLocalSub) destLocalSub.textContent = localInfo.folder;
      if (refreshLocalBtn) refreshLocalBtn.hidden = false;
    } else {
      localLastEl.textContent = 'Never';
      localFolderRow.hidden = true;
      localCountRow.hidden = true;
      if (destLocalSub) destLocalSub.textContent = 'No local backup yet.';
      if (refreshLocalBtn) refreshLocalBtn.hidden = true;
    }

    document.getElementById('storage-path').textContent = state.settings.vaultRoot;
    document.getElementById('app-version').textContent = 'v' + state.settings.version;
    document.getElementById('auto-lock-status').textContent = state.settings.autoLockOnIdle ? 'Enabled' : 'Disabled';

    const activeProjects = state.projects.filter((p) => p.status === 'active').length;
    const archivedProjects = state.projects.filter((p) => p.status === 'archived').length;
    document.getElementById('health-integrity').textContent =
      'OK — ' + activeProjects + ' active + ' + archivedProjects + ' archived projects';
    document.getElementById('health-sessions').textContent =
      state.currentProject ? state.currentProject.displayName + ' (loaded)' : 'None loaded';

    // Drive sync button (kept for "Coming Soon" state — always disabled now)
    const syncBtn = document.getElementById('sync-now-btn');
    if (syncBtn) syncBtn.disabled = true;
  }

  // ─── 7. COMPONENTS ─────────────────────────────────────────────────
  function metaRow(label, value) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    const l = document.createElement('div');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'meta-value';
    v.textContent = value;
    wrapper.appendChild(l);
    wrapper.appendChild(v);
    return wrapper;
  }

  function renderProjectCard(p) {
    const card = document.createElement('div');
    card.className = 'project-card ' + (p.status === 'archived' ? 'archived' : '');
    const remote = p.gitRemoteUrl || '(no git remote)';
    const path = p.lastKnownPath || '(unknown path)';
    const fpShort = p.fingerprint.slice(0, 16);
    const keyCountLine = typeof p.knownCount === 'number'
      ? p.knownCount + ' key' + (p.knownCount === 1 ? '' : 's') + ' stored'
      : 'Click to unlock';
    card.innerHTML =
      '<div class="project-card-header">' +
        '<div class="title">' + escapeHtml(p.displayName || 'unnamed') + '</div>' +
        '<span class="status-badge ' + p.status + '">' + p.status + '</span>' +
      '</div>' +
      '<div class="meta-line"><span class="icon">' + icon('link', 'vp-icon-sm') + '</span>' + escapeHtml(remote) + '</div>' +
      '<div class="meta-line"><span class="icon">' + icon('folder', 'vp-icon-sm') + '</span>' + escapeHtml(path) + '</div>' +
      '<div class="meta-line"><span class="icon">' + icon('key', 'vp-icon-sm') + '</span>' + escapeHtml(keyCountLine) + '</div>' +
      '<div class="fingerprint">' + escapeHtml(fpShort) + '</div>' +
      '<div class="project-card-actions">' +
        // Hide Download .env when we know the project is empty.
        (p.knownCount === 0
          ? ''
          : '<button class="pc-action-btn" data-pc-action="download-env">' + icon('download', 'vp-icon-sm') + '<span>Download .env</span></button>') +
        (p.status === 'archived'
          ? ('<button class="pc-action-btn" data-pc-action="unarchive-project">' + icon('archive-restore', 'vp-icon-sm') + '<span>Unarchive</span></button>' +
             '<button class="pc-action-btn danger" data-pc-action="delete-archived">' + icon('trash', 'vp-icon-sm') + '<span>Delete</span></button>')
          : '<button class="pc-action-btn" data-pc-action="archive-project">' + icon('archive', 'vp-icon-sm') + '<span>Archive</span></button>') +
      '</div>';
    card.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pc-action]');
      if (btn) {
        e.stopPropagation();
        const name = p.displayName || 'unnamed';
        if (btn.dataset.pcAction === 'download-env') downloadEnv(p.fingerprint);
        else if (btn.dataset.pcAction === 'archive-project') archiveProject(p.fingerprint, name);
        else if (btn.dataset.pcAction === 'unarchive-project') unarchiveProject(p.fingerprint, name);
        else if (btn.dataset.pcAction === 'delete-archived') deleteArchived(p.fingerprint, name);
        return;
      }
      navigate('project', { project: p });
    });
    return card;
  }

  function renderCreateVaultCard() {
    const card = document.createElement('div');
    card.className = 'create-vault-card';
    card.innerHTML =
      '<div class="plus">' + icon('plus', 'vp-icon-lg') + '</div>' +
      '<div class="label">Create New Vault</div>' +
      '<div class="sub">Initialize for current workspace</div>';
    card.addEventListener('click', createNewVault);
    return card;
  }

  function renderCredentialCard(c, fingerprint) {
    const card = document.createElement('div');
    card.className = 'credential-card';
    const isPair = c.type === 'user/password-pair';

    let valueBlock;
    if (isPair) {
      valueBlock =
        '<div class="pair-fields-row">' +
          '<div class="pair-label">' + escapeHtml(c.fields.fieldA.label) + '</div>' +
          '<div class="value-row">' +
            '<input class="value-input" type="text" data-cred-value="' + c.id + ':fieldA" value="••••••••" readonly>' +
          '</div>' +
        '</div>' +
        '<div class="pair-fields-row">' +
          '<div class="pair-label">' + escapeHtml(c.fields.fieldB.label) + '</div>' +
          '<div class="value-row">' +
            '<input class="value-input" type="text" data-cred-value="' + c.id + ':fieldB" value="••••••••" readonly>' +
          '</div>' +
        '</div>';
    } else {
      valueBlock =
        '<div class="value-row">' +
          '<input class="value-input" type="text" data-cred-value="' + c.id + '" value="••••••••" readonly>' +
          '<button class="icon-btn" title="Reveal" data-action="reveal" data-id="' + c.id + '">' + icon('eye') + '</button>' +
          '<button class="icon-btn" title="Copy" data-action="copy" data-id="' + c.id + '">' + icon('copy') + '</button>' +
        '</div>';
    }

    card.innerHTML =
      '<div class="row1">' +
        '<span class="credential-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="type-pill" data-type="' + c.type + '">' + c.type + '</span>' +
      '</div>' +
      (c.notes ? '<div class="subtitle">' + escapeHtml(c.notes) + '</div>' : '') +
      valueBlock +
      '<div class="value-row" style="margin-top:8px;">' +
        '<button class="secondary-btn" data-action="edit" data-id="' + c.id + '">Edit</button>' +
        '<button class="secondary-btn" data-action="delete" data-id="' + c.id + '">Delete</button>' +
      '</div>';

    card.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.getAttribute('data-action');
      const id = t.getAttribute('data-id');
      if (!action || !id) return;
      switch (action) {
        case 'reveal': inlineReveal(id, fingerprint); break;
        case 'copy': inlineCopy(id, fingerprint); break;
        case 'edit': inlineEdit(id, fingerprint); break;
        case 'delete': inlineDelete(id, fingerprint); break;
      }
    });

    return card;
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function renderLocalBackupVaults(vaults, folder, error) {
    const status = document.getElementById('local-inspect-status');
    const list = document.getElementById('local-inspect-vaults');
    list.innerHTML = '';
    if (error) {
      status.innerHTML = icon('alert', 'vp-icon-sm') + ' ' + escapeHtml(error);
      return;
    }
    if (!vaults || vaults.length === 0) {
      status.innerHTML = icon('alert', 'vp-icon-sm') + ' No vaults found in the backup folder.';
      return;
    }
    status.innerHTML =
      icon('check', 'vp-icon-sm') + ' ' + vaults.length + ' vault' +
      (vaults.length === 1 ? '' : 's') + ' in ' + escapeHtml(folder || '') +
      '<div class="inspect-project-locked-hint" style="margin-top:6px;">' +
      'Each vault is an AES-256 encrypted ZIP. Open it externally with Keka, 7-Zip, or WinZip ' +
      'using the backup passphrase you set when running Back Up Locally.</div>';

    vaults.forEach((v) => {
      const row = document.createElement('div');
      row.className = 'local-vault-row';
      row.dataset.fingerprint = v.fingerprint;
      const remote = v.gitRemoteUrl
        ? '<div class="lv-fp">' + icon('link', 'vp-icon-sm') + ' ' + escapeHtml(v.gitRemoteUrl) + '</div>'
        : '';
      const action = v.hasZip
        ? '<button class="lv-view-btn" data-action="reveal">' +
            icon('folder', 'vp-icon-sm') + '<span>Reveal in File Manager</span></button>'
        : '<span class="inspect-project-count locked">' + icon('alert', 'vp-icon-sm') + ' Missing .env.zip</span>';
      row.innerHTML =
        '<div class="lv-head">' +
          '<div>' +
            '<div class="lv-name">' + escapeHtml(v.displayName) +
              ' <span class="status-badge ' + v.status + '">' + v.status + '</span>' +
            '</div>' +
            '<div class="lv-fp">' + escapeHtml(v.fingerprint) + '</div>' +
            remote +
          '</div>' +
          action +
        '</div>';
      const revealBtn = row.querySelector('[data-action="reveal"]');
      if (revealBtn) {
        revealBtn.addEventListener('click', () => {
          revealLocalVault(v.fingerprint, v.status);
        });
      }
      list.appendChild(row);
    });
  }

  function renderDriveBackupContents(inspection, error) {
    const section = document.getElementById('drive-inspect-section');
    const statusEl = document.getElementById('drive-inspect-status');
    const listEl = document.getElementById('drive-inspect-projects');
    section.hidden = false;

    if (error) {
      statusEl.innerHTML = icon('alert', 'vp-icon-sm') + ' ' + escapeHtml(error);
      listEl.innerHTML = '';
      return;
    }
    if (!inspection) {
      statusEl.innerHTML = icon('alert', 'vp-icon-sm') + ' No inspection result.';
      listEl.innerHTML = '';
      return;
    }

    const unlockedProjects = inspection.projects.filter((p) => p.unlockState === 'unlocked');
    const lockedProjects = inspection.projects.filter((p) => p.unlockState === 'locked');
    const totalCreds = unlockedProjects.reduce((s, p) => s + p.credentialNames.length, 0);

    if (unlockedProjects.length === 0 && lockedProjects.length > 0) {
      statusEl.innerHTML =
        icon('lock', 'vp-icon-sm') + ' ' + lockedProjects.length + ' project' +
        (lockedProjects.length === 1 ? '' : 's') +
        " couldn't be decrypted with that passphrase. Try Again below to retry.";
    } else {
      const summaryBits = [
        icon('check', 'vp-icon-sm') + ' ' + unlockedProjects.length + ' unlocked',
      ];
      if (lockedProjects.length > 0) {
        summaryBits.push(icon('lock', 'vp-icon-sm') + ' ' + lockedProjects.length + ' locked (different passphrase)');
      }
      summaryBits.push(totalCreds + ' credential' + (totalCreds === 1 ? '' : 's'));
      summaryBits.push(formatBytes(inspection.fileBytes));
      statusEl.innerHTML = summaryBits.join(' — ');
    }

    // Show retry button whenever at least one project is locked.
    const retryRow = document.getElementById('drive-inspect-retry-row');
    retryRow.hidden = lockedProjects.length === 0;

    listEl.innerHTML = '';
    inspection.projects.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'inspect-project' + (p.unlockState === 'locked' ? ' locked' : '');
      const isLocked = p.unlockState === 'locked';
      const credChips = p.credentialNames
        .map((n) => '<span class="inspect-cred-name">' + escapeHtml(n) + '</span>')
        .join('');
      const rightBadge = isLocked
        ? '<span class="inspect-project-count locked">' + icon('lock', 'vp-icon-sm') + ' locked</span>'
        : '<span class="inspect-project-count">' + p.credentialNames.length + ' key' + (p.credentialNames.length === 1 ? '' : 's') + '</span>';
      const credBlock = isLocked
        ? '<div class="inspect-project-locked-hint">Different passphrase — credential names hidden until unlocked.</div>'
        : '<div class="inspect-project-creds" style="margin-top:8px;">' + (credChips || '<span class="inspect-project-fp">(empty)</span>') + '</div>';
      row.innerHTML =
        '<div class="inspect-project-header">' +
          '<div>' +
            '<span class="inspect-project-name">' + escapeHtml(p.displayName) + '</span> ' +
            '<span class="status-badge ' + p.status + '">' + p.status + '</span>' +
          '</div>' +
          rightBadge +
        '</div>' +
        '<div class="inspect-project-fp">' + escapeHtml(p.fingerprint) + '</div>' +
        credBlock;
      listEl.appendChild(row);
    });
  }

  function renderDriveBackupLive(info, error) {
    const statusRow = document.getElementById('drive-refresh-status-row');
    const statusEl = document.getElementById('drive-refresh-status');
    const modifiedRow = document.getElementById('drive-modified-row');
    const modifiedEl = document.getElementById('drive-backup-modified');

    statusRow.hidden = false;
    const looksAbsent =
      (!!error && /no backup file|not found|no file/i.test(error)) ||
      (!error && !info);

    if (error) {
      statusEl.innerHTML = icon('alert', 'vp-icon-sm') + ' ' + escapeHtml(error);
      modifiedRow.hidden = true;
      if (looksAbsent) {
        state.knownBackupAbsent = true;
        renderSettings();
      }
      return;
    }
    if (!info) {
      statusEl.innerHTML = icon('alert', 'vp-icon-sm') + ' No file found in Drive appdata.';
      modifiedRow.hidden = true;
      state.knownBackupAbsent = true;
      renderSettings();
      return;
    }

    // File is present — clear any stale "absent" flag.
    state.knownBackupAbsent = false;

    // Update the detail rows with the live values.
    document.getElementById('drive-size-row').hidden = false;
    document.getElementById('drive-name-row').hidden = false;
    document.getElementById('drive-fileid-row').hidden = false;
    document.getElementById('drive-backup-size').textContent = formatBytes(info.bytes);
    document.getElementById('drive-backup-name').textContent = info.fileName;
    document.getElementById('drive-backup-fileid').textContent = info.fileId;
    if (info.md5) {
      document.getElementById('drive-md5-row').hidden = false;
      document.getElementById('drive-backup-md5').textContent = info.md5;
    }
    if (info.modifiedTime) {
      modifiedRow.hidden = false;
      modifiedEl.textContent =
        new Date(info.modifiedTime).toLocaleString() + ' (' + info.modifiedTime + ')';
    }
    statusEl.innerHTML = icon('check', 'vp-icon-sm') + ' Live from Drive — ' + new Date().toLocaleTimeString();
    // Re-run renderSettings so the buttons reflect the new known state.
    renderSettings();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── 8. INIT ───────────────────────────────────────────────────────
  function init() {
    // Nav rail
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.addEventListener('click', () => navigate(el.dataset.view));
    });

    // Dashboard toolbar
    document.getElementById('search-input').addEventListener('input', (e) => {
      state.filter.search = e.target.value;
      renderDashboard();
    });
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        state.filter.tab = t.dataset.tab;
        renderDashboard();
      });
    });
    document.getElementById('sort-select').addEventListener('change', (e) => {
      state.filter.sort = e.target.value;
      renderDashboard();
    });

    // Project view
    document.getElementById('back-to-dashboard').addEventListener('click', () => navigate('dashboard'));
    document.getElementById('add-key-btn').addEventListener('click', () => {
      if (state.currentProject) addCredential(state.currentProject.fingerprint);
    });

    // Settings view — local backup
    const localBtn = document.getElementById('local-backup-btn');
    if (localBtn) localBtn.addEventListener('click', localBackup);
    const refreshLocalBtn = document.getElementById('refresh-local-btn');
    if (refreshLocalBtn) refreshLocalBtn.addEventListener('click', refreshLocalBackup);

    const inspectLocalBtn = document.getElementById('inspect-local-btn');
    if (inspectLocalBtn) {
      inspectLocalBtn.addEventListener('click', () => {
        const result = document.getElementById('local-inspect-result');
        const status = document.getElementById('local-inspect-status');
        const list = document.getElementById('local-inspect-vaults');
        result.hidden = false;
        status.textContent = 'Reading backup folder…';
        list.innerHTML = '';
        inspectLocalBackup();
      });
    }

    document.getElementById('open-docs-btn').addEventListener('click', () => openDocsLink('readme'));
    document.getElementById('open-changelog-btn').addEventListener('click', () => openDocsLink('changelog'));

    // Initial data
    listProjects();
    loadSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
