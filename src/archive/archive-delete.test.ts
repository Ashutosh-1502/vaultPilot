import * as assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { checkDeletionConfirmation } from './archive-delete';

describe('checkDeletionConfirmation', () => {
  it('returns true on exact match', () => {
    assert.equal(checkDeletionConfirmation('valtPilot', 'valtPilot'), true);
  });

  it('returns false on case mismatch (case-sensitive per FR-31)', () => {
    assert.equal(checkDeletionConfirmation('valtPilot', 'valtpilot'), false);
    assert.equal(checkDeletionConfirmation('valtPilot', 'VALTPILOT'), false);
  });

  it('returns false on partial match', () => {
    assert.equal(checkDeletionConfirmation('valtPilot', 'valt'), false);
    assert.equal(checkDeletionConfirmation('valt', 'valtPilot'), false);
  });

  it('returns false on whitespace differences', () => {
    assert.equal(checkDeletionConfirmation('valtPilot', ' valtPilot'), false);
    assert.equal(checkDeletionConfirmation('valtPilot', 'valtPilot '), false);
  });

  it('handles empty strings', () => {
    assert.equal(checkDeletionConfirmation('', ''), true);
    assert.equal(checkDeletionConfirmation('valtPilot', ''), false);
    assert.equal(checkDeletionConfirmation('', 'valtPilot'), false);
  });

  it('handles unicode display names exactly', () => {
    assert.equal(checkDeletionConfirmation('café', 'café'), true);
    // NFC vs NFD — different byte sequences, even though visually identical.
    assert.equal(checkDeletionConfirmation('café'.normalize('NFC'), 'café'.normalize('NFD')), false);
  });
});
