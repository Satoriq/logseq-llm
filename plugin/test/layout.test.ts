import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activate, addTab, allTabs, closeTab, groupOf, groups, moveTab, newGroup, parseLayout, setRatio, zoneAt } from '../src/layout.ts';
import type { LayoutNode, Split, Tab } from '../src/layout.ts';

const tab = (id: string): Tab => ({ id, chatId: null });
/** One group holding tabs a, b, c. */
const abc = (): LayoutNode => addTab(addTab(newGroup('g1', tab('a')), 'g1', tab('b')), 'g1', tab('c'));
const shape = (n: LayoutNode): unknown => (n.kind === 'group' ? n.tabs.map((t) => t.id).join('') : [n.dir, shape(n.a), shape(n.b)]);

test('a new tab joins the group and shows', () => {
  const l = abc();
  assert.equal(shape(l), 'abc');
  assert.equal(groups(l)[0]?.active, 'c');
});

test('dragging a tab to an edge halves the group and takes that side', () => {
  assert.deepEqual(shape(moveTab(abc(), 'c', 'g1', 'right', 'g2')), ['row', 'ab', 'c']);
  assert.deepEqual(shape(moveTab(abc(), 'c', 'g1', 'left', 'g2')), ['row', 'c', 'ab']);
  assert.deepEqual(shape(moveTab(abc(), 'c', 'g1', 'bottom', 'g2')), ['col', 'ab', 'c']);
  assert.deepEqual(shape(moveTab(abc(), 'c', 'g1', 'top', 'g2')), ['col', 'c', 'ab']);
});

test('the halves can be halved again, in either direction', () => {
  let l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  l = moveTab(l, 'b', 'g2', 'bottom', 'g3');
  assert.deepEqual(shape(l), ['row', 'a', ['col', 'c', 'b']]);
});

test('closing the second chat gives the first one the whole space again', () => {
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  const closed = closeTab(l, 'c') as LayoutNode;
  assert.equal(closed.kind, 'group');
  assert.equal(shape(closed), 'ab');
});

test('closing inside nested splits collapses only that split', () => {
  let l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  l = moveTab(l, 'b', 'g2', 'bottom', 'g3');
  assert.deepEqual(shape(closeTab(l, 'b') as LayoutNode), ['row', 'a', 'c']);
  assert.deepEqual(shape(closeTab(l, 'a') as LayoutNode), ['col', 'c', 'b']);
});

test('closing the shown tab shows its neighbour, and the last tab of all leaves nothing', () => {
  const l = activate(abc(), 'b');
  assert.equal(groups(closeTab(l, 'b') as LayoutNode)[0]?.active, 'c');
  assert.equal(groups(closeTab(activate(abc(), 'c'), 'c') as LayoutNode)[0]?.active, 'b');
  assert.equal(groups(closeTab(activate(abc(), 'c'), 'a') as LayoutNode)[0]?.active, 'c', 'closing another tab changes nothing shown');
  assert.equal(closeTab(newGroup('g', tab('a')), 'a'), null);
});

test('dragging a tab into another group\'s middle joins it, and an emptied group goes away', () => {
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  const joined = moveTab(l, 'c', 'g1', 'center', 'x');
  assert.equal(shape(joined), 'abc');
  assert.equal(joined.kind, 'group');
  assert.equal(groups(joined)[0]?.active, 'c');
});

test('a drop at a position in the tab row puts it there', () => {
  assert.equal(shape(moveTab(abc(), 'c', 'g1', 'center', 'x', 0)), 'cab');
  assert.equal(shape(moveTab(abc(), 'a', 'g1', 'center', 'x', 1)), 'bac');
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  assert.deepEqual(shape(moveTab(l, 'a', 'g2', 'center', 'x', 0)), ['row', 'b', 'ac']);
});

test('a group\'s only tab can\'t split from itself, but can move to another group\'s edge', () => {
  const single = newGroup('g', tab('a'));
  assert.equal(moveTab(single, 'a', 'g', 'right', 'x'), single);
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  assert.deepEqual(shape(moveTab(l, 'c', 'g1', 'top', 'g3')), ['col', 'c', 'ab']);
});

test('moving something that isn\'t there changes nothing', () => {
  const l = abc();
  assert.equal(moveTab(l, 'nope', 'g1', 'left', 'x'), l);
  assert.equal(moveTab(l, 'a', 'nope', 'left', 'x'), l);
});

test('a tab keeps its own model through every move', () => {
  const claude: Tab = { id: 'a', chatId: 'chat', provider: 'claude', model: 'opus', effort: 'high' };
  const l = moveTab(addTab(newGroup('g1', claude), 'g1', tab('b')), 'a', 'g1', 'right', 'g2');
  assert.deepEqual(allTabs(l).find((t) => t.id === 'a'), claude);
  assert.equal(groupOf(l, 'a')?.id, 'g2');
});

test('zones: the middle half joins, the rest is the nearest edge', () => {
  const r = { left: 100, top: 100, width: 400, height: 800 };
  assert.equal(zoneAt(r, 300, 500), 'center');
  assert.equal(zoneAt(r, 120, 500), 'left');
  assert.equal(zoneAt(r, 480, 500), 'right');
  assert.equal(zoneAt(r, 300, 120), 'top');
  assert.equal(zoneAt(r, 300, 880), 'bottom');
});

test('a split starts at half, and its line can move', () => {
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2') as Split;
  assert.equal(l.ratio, 0.5);
  assert.equal((setRatio(l, '', 0.3) as Split).ratio, 0.3);
});

test('the right split moves, however deep it is', () => {
  const l = moveTab(moveTab(abc(), 'c', 'g1', 'right', 'g2'), 'b', 'g1', 'bottom', 'g3');
  const moved = setRatio(l, 'a', 0.7) as Split;
  assert.equal((moved.a as Split).ratio, 0.7);
  assert.equal(moved.ratio, 0.5, 'the outer one stays');
});

test('neither side can be dragged out of reach', () => {
  const l = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  assert.equal((setRatio(l, '', 0) as Split).ratio, 0.15);
  assert.equal((setRatio(l, '', 1) as Split).ratio, 0.85);
});

test('closing a tab keeps the other splits where you put them', () => {
  const l = setRatio(moveTab(moveTab(abc(), 'c', 'g1', 'right', 'g2'), 'b', 'g2', 'bottom', 'g3'), '', 0.3);
  assert.equal((closeTab(l, 'b') as Split).ratio, 0.3);
});

test('a saved layout comes back whole', () => {
  const l = setRatio(moveTab(abc(), 'c', 'g1', 'right', 'g2'), '', 0.3);
  assert.deepEqual(parseLayout(JSON.stringify(l)), l);
});

test('damage in a saved layout is dropped, never trusted', () => {
  assert.equal(parseLayout('not json'), null);
  assert.equal(parseLayout('null'), null);
  assert.equal(parseLayout('{"kind":"group","id":"g","tabs":[],"active":"x"}'), null);
  assert.equal(parseLayout('{"kind":"split","dir":"sideways","a":{},"b":{}}'), null);
  const wild = moveTab(abc(), 'c', 'g1', 'right', 'g2');
  assert.equal((parseLayout(JSON.stringify({ ...wild, ratio: 99 })) as Split).ratio, 0.85);
  assert.equal((parseLayout(JSON.stringify({ ...wild, ratio: 'x' })) as Split).ratio, 0.5);
  assert.equal((parseLayout(JSON.stringify({ ...wild, ratio: undefined })) as Split).ratio, 0.5, 'saved before splits could move');
  const good = newGroup('g', tab('a'));
  const halfBroken = parseLayout(JSON.stringify({ kind: 'split', dir: 'row', a: good, b: { kind: 'nope' } })) as LayoutNode;
  assert.equal(shape(halfBroken), 'a', 'the good half survives, on its own');
  const twice = parseLayout(JSON.stringify({ kind: 'split', dir: 'row', a: good, b: newGroup('h', tab('a')) })) as LayoutNode;
  assert.equal(allTabs(twice).length, 1, 'the same tab id twice would be one view in two places');
  const lostActive = parseLayout(JSON.stringify({ ...good, active: 'gone' })) as LayoutNode;
  assert.equal(groups(lostActive)[0]?.active, 'a');
  const stray = parseLayout(JSON.stringify({ ...good, tabs: [{ id: 'a', chatId: 7, provider: {}, evil: 'x' }] })) as LayoutNode;
  assert.deepEqual(allTabs(stray), [{ id: 'a', chatId: null }]);
});

test('splits nest as a tree, not a list', () => {
  const l = moveTab(moveTab(abc(), 'c', 'g1', 'right', 'g2'), 'b', 'g1', 'bottom', 'g3') as Split;
  assert.equal(l.kind, 'split');
  assert.equal(l.a.kind, 'split');
  assert.deepEqual(shape(l), ['row', ['col', 'a', 'b'], 'c']);
});
