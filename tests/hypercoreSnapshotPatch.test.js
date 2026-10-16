// hypercore's _updateSnapshotStorage reads `this.atomized` again after a
// wait, when it may be null (src/hypercoreSnapshotPatch.js).

const SessionState = require('hypercore/lib/session-state')
const { applySnapshotFlushFix } = require('../src/hypercoreSnapshotPatch')

// A session whose atomic batch finishes, and is cleared, while it waits.
function session () {
  const s = { treeInfo: () => ({ fork: 0, roots: [], length: 0 }) }
  const atom = { flushing: true, flushed: async () => { atom.flushing = false; s.atomized = null } }
  s.atomized = atom
  return s
}
const storage = {
  read: () => ({ getHead: async () => null, getAuth: async () => ({ manifest: null }), getDependency: async () => null, getTreeNode: async () => null, tryFlush () {} }),
  setDependencyHead () {}
}

// Runs first, before this file patches anything.
test('upstream throws when the batch is cleared during the wait', async () => {
  expect(SessionState.prototype._updateSnapshotStorage.__snapshotFlushFixed).toBeUndefined()
  // If this stops throwing, hypercore has fixed it: drop the patch.
  await expect(SessionState.prototype._updateSnapshotStorage.call(session(), storage)).rejects.toThrow(/flushing/)
})

test('the patched version waits on the batch it saw', async () => {
  expect(applySnapshotFlushFix(SessionState)).toBe(true)
  expect(SessionState.prototype._updateSnapshotStorage.__snapshotFlushFixed).toBe(true)
  await expect(SessionState.prototype._updateSnapshotStorage.call(session(), storage)).resolves.toEqual({ fork: 0, roots: [], length: 0, prologue: null, signature: null })
  expect(applySnapshotFlushFix(SessionState)).toBe(false)
})
