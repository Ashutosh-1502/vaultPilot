/* ============================================================================
 * VaultPilot — Passphrase Prompt Script
 *
 * Modes:
 *   - single: one input ("unlock", "restore", "import")
 *   - confirm: two inputs, must match (first-run set-up)
 *
 * Lightweight strength heuristic that mirrors src/ui/strength-meter.ts on
 * the extension side. We re-implement it in pure JS here so the meter can
 * update on every keystroke without a round-trip to the extension.
 * ========================================================================= */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const mode = (window).__VP_MODE__ || 'single'; // 'single' | 'confirm'

  const pass1 = document.getElementById('pass1');
  const pass2 = document.getElementById('pass2');
  const strength1 = document.getElementById('strength1');
  const matchWarning = document.getElementById('match-warning');
  const confirmBlock = document.getElementById('confirm-block');
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const reveal1 = document.getElementById('reveal1');
  const reveal2 = document.getElementById('reveal2');

  if (mode === 'confirm') {
    confirmBlock.hidden = false;
  }

  // ─── Strength meter (mirrors src/ui/strength-meter.ts) ────────────
  function scorePassphrase(input) {
    const length = input.length;
    let classes = 0;
    if (/[a-z]/.test(input)) classes++;
    if (/[A-Z]/.test(input)) classes++;
    if (/[0-9]/.test(input)) classes++;
    if (/[^a-zA-Z0-9]/.test(input)) classes++;
    const score = length * (1 + 0.25 * Math.max(0, classes - 1));
    let level;
    if (length < 12) level = 'weak';
    else if (score >= 20) level = 'strong';
    else level = 'ok';
    return { score, level, length, classes };
  }

  function renderStrength(input) {
    if (input.length === 0) {
      strength1.textContent = '';
      strength1.removeAttribute('data-level');
      return;
    }
    const s = scorePassphrase(input);
    strength1.dataset.level = s.level;
    if (s.level === 'weak') {
      strength1.textContent = `Strength: weak — ${input.length} chars (12+ recommended)`;
    } else if (s.level === 'ok') {
      strength1.textContent = `Strength: OK — ${input.length} chars`;
    } else {
      strength1.textContent = `Strength: strong — ${input.length} chars`;
    }
  }

  // ─── Validation ───────────────────────────────────────────────────
  function passphrasesMatch() {
    if (mode !== 'confirm') return true;
    return pass1.value === pass2.value;
  }

  function updateValidation() {
    if (mode === 'confirm' && pass1.value.length > 0 && pass2.value.length > 0) {
      matchWarning.hidden = passphrasesMatch();
    } else {
      matchWarning.hidden = true;
    }
    const valid = pass1.value.length > 0 && passphrasesMatch();
    submitBtn.disabled = !valid;
  }

  // ─── Show/hide toggles ────────────────────────────────────────────
  const EYE_SVG =
    '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG =
    '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7c2.4 0 4.4.9 6 2"/><path d="M22 12s-4 7-10 7c-2.4 0-4.4-.9-6-2"/><path d="M3 3l18 18"/><path d="M9.5 9.5a3 3 0 0 0 4 4"/></svg>';

  function toggleReveal(input, btn) {
    if (input.type === 'password') {
      input.type = 'text';
      btn.innerHTML = EYE_OFF_SVG;
    } else {
      input.type = 'password';
      btn.innerHTML = EYE_SVG;
    }
  }
  reveal1.addEventListener('click', () => toggleReveal(pass1, reveal1));
  if (reveal2) reveal2.addEventListener('click', () => toggleReveal(pass2, reveal2));

  // ─── Submit / cancel ──────────────────────────────────────────────
  function submit() {
    if (!passphrasesMatch() || pass1.value.length === 0) return;
    vscode.postMessage({ kind: 'submit', value: pass1.value });
    // Clear from DOM as a small defense-in-depth measure
    pass1.value = '';
    if (pass2) pass2.value = '';
  }

  function cancel() {
    vscode.postMessage({ kind: 'cancel' });
    pass1.value = '';
    if (pass2) pass2.value = '';
  }

  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);

  // ─── Keyboard shortcuts ───────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });

  pass1.addEventListener('input', () => {
    renderStrength(pass1.value);
    updateValidation();
  });
  if (pass2) pass2.addEventListener('input', updateValidation);

  // Focus on load
  setTimeout(() => pass1.focus(), 50);
  updateValidation();
})();
