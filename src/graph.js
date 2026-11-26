// The site map as a star graph. Every node is a page; `parent` draws the edge.
// To add a page: add a node here. `body` names a module in src/bodies/ (falls back to a plain star).
// `href` (optional) makes "Enter" open a real page instead of the placeholder.
export const NODES = [
  { id: 'home', parent: null, title: 'Home', pos: [0, 0, 0],
    body: 'star', opts: { color: '#ffb061', radius: 1.7, seed: 1, spikes: 0.7 }, color: '#ffc27a', view: 9.5,
    desc: 'The centre of the map. Everything here orbits one place: problems worth losing sleep over, research, work, and writing.' },

  { id: 'riddles', parent: 'home', title: 'Riddles', pos: [-17, -15, -13],
    body: 'blackhole', opts: { seed: 5 }, rot: [0.32, 0, -0.2], color: '#ff9a52', view: 8.5,
    desc: 'Fun, elegant problems. Easy to fall into, hard to climb out of. Light bends here and so will your afternoon.' },
  { id: 'research', parent: 'home', title: 'Research', pos: [-12, 17, 15],
    body: 'pulsar', opts: { seed: 7 }, rot: [0.25, 0.6, 0.3], color: '#6fe9ff', view: 11.5,
    desc: 'A beacon sweeping the dark for answers. Papers, experiments and the things that did not fit in a paper.' },
  { id: 'work', parent: 'home', title: 'Work', pos: [20, 13, -8],
    body: 'system', opts: { seed: 3 }, rot: [0.38, 0.4, 0.12], color: '#9cc4ff', view: 9.5,
    desc: 'Worlds that got built. Projects, competition bots and tools made for teaching, each one a planet with its own weather.' },
  { id: 'blog', parent: 'home', title: 'Blog', pos: [13, -13, 17],
    body: 'nebula', opts: { seed: 9 }, rot: [0.1, 0.9, 0], color: '#ff6fb1', view: 6.6,
    desc: 'Writing, condensing out of the gas. Half-formed ideas; some of them will become stars.' },

  { id: 'puzzles', parent: 'riddles', title: 'Puzzles', pos: [-27, -11, -21], body: 'star', opts: { color: '#ff7a4a', radius: 0.4, seed: 14 }, color: '#ff9a72', view: 3.3, desc: 'A collection of particularly fun problems.' },
  { id: 'proofs', parent: 'riddles', title: 'Proofs', pos: [-22, -26, -8], body: 'star', opts: { color: '#ff4f5e', radius: 0.36, seed: 15, corona: 0.6 }, color: '#ff8090', view: 3.2, desc: 'The elegant ones, written up properly.' },

  { id: 'papers', parent: 'research', title: 'Papers', pos: [-22, 23, 19], body: 'star', opts: { color: '#dfe6ff', radius: 0.36, seed: 12, corona: 0.6 }, color: '#e6ecff', view: 3.2, desc: 'Papers, benchmarks and write-ups.' },
  { id: 'lab', parent: 'research', title: 'Experiments', pos: [-8, 28, 24], body: 'star', opts: { color: '#7fe0d0', radius: 0.38, seed: 13, corona: 0.6 }, color: '#9af0e0', view: 3.2, desc: 'Small things built on a weekend to see if they would work.' },

  { id: 'bots', parent: 'work', title: 'Battlecode', pos: [29, 20, -14], body: 'star', opts: { color: '#8fb4ff', radius: 0.42, seed: 11, corona: 0.6 }, color: '#a9c8ff', view: 3.4, desc: 'Competition bots and the tooling around them.' },
  { id: 'factoring', parent: 'work', title: 'Factoring', pos: [30, 5, 0], body: 'star', opts: { color: '#66f0ff', radius: 0.38, seed: 16, corona: 0.6 }, color: '#8ff4ff', view: 3.2, href: 'factoring.html', desc: 'Timed quadratic factoring practice.' },
  { id: 'linear', parent: 'work', title: 'Linear equations', pos: [21, 24, -18], body: 'star', opts: { color: '#b08cff', radius: 0.38, seed: 17, corona: 0.6 }, color: '#c6aaff', view: 3.2, href: 'linear.html', desc: 'Timed linear equation solving practice.' },

  { id: 'archive', parent: 'blog', title: 'Archive', pos: [23, -21, 22], body: 'star', opts: { color: '#ff7fd0', radius: 0.38, seed: 18, corona: 0.6 }, color: '#ffa0de', view: 3.2, desc: 'Old posts, kept because deleting them felt wrong.' },
  { id: 'links', parent: 'blog', title: 'Friends', pos: [8, -24, 26], body: 'star', opts: { color: '#ffd36a', radius: 0.36, seed: 19, corona: 0.6 }, color: '#ffe08f', view: 3.2, desc: 'Cool websites by cool people.' },
];
export const byId = Object.fromEntries(NODES.map(n => [n.id, n]));
export const childrenOf = id => NODES.filter(n => n.parent === id);
