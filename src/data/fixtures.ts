// Deliberately fictional, static fixtures. Never use these as execution inputs.
export const marketFixtures = [
  { id: 'eth-base', symbol: 'ETH', name: 'Ethereum', chain: 'Base', price: 2842.65, change: 2.34, volume: 18420000, liquidity: 12650000, pool: 'ETH / USDC', history: [34,30,37,33,45,40,51,48,54,49,63,60,68,64,78] },
  { id: 'sol-solana', symbol: 'SOL', name: 'Solana', chain: 'Solana', price: 148.92, change: 4.12, volume: 12360000, liquidity: 8430000, pool: 'SOL / USDC', history: [25,32,28,41,36,52,48,58,53,65,59,75,71,82,88] },
  { id: 'bnb-bsc', symbol: 'BNB', name: 'BNB', chain: 'BNB Smart Chain', price: 612.48, change: -0.86, volume: 7850000, liquidity: 6920000, pool: 'BNB / USDC', history: [78,71,75,63,69,61,57,66,52,57,46,50,42,47,39] },
  { id: 'usdc-base', symbol: 'USDC', name: 'USD Coin', chain: 'Base', price: 1, change: 0.01, volume: 24670000, liquidity: 18450000, pool: 'USDC / ETH', history: [49,50,49,51,50,50,49,50,51,50,50,49,50,50,51] },
  { id: 'eth-robinhood', symbol: 'ETH', name: 'Ethereum', chain: 'Robinhood Chain', price: null, change: null, volume: null, liquidity: null, pool: 'Not configured', history: [] },
];
export const activityFixtures = [
  { id: 'DEMO-0081', time: '14:32:08', category: 'research', chain: 'Base', action: 'Market analysis completed', result: 'Completed', detail: 'Sample liquidity and price observations were organized into a research report. No transaction was proposed.' },
  { id: 'DEMO-0080', time: '14:30:42', category: 'risk', chain: 'Solana', action: 'Position size limit checked', result: 'Blocked', detail: 'A simulated $600 position exceeded the $500 maximum trade size. The deterministic check rejected the proposal.' },
  { id: 'DEMO-0079', time: '14:28:15', category: 'liquidity', chain: 'Base', action: 'Liquidity range reviewed', result: 'Hold', detail: 'The sample position remains inside its configured range. No rebalance is proposed.' },
  { id: 'DEMO-0078', time: '14:25:03', category: 'trade', chain: 'Base', action: 'Paper position opened', result: 'Simulated', detail: 'A simulated ETH position passed example risk limits. Nothing was signed or broadcast.' },
  { id: 'DEMO-0077', time: '14:20:00', category: 'system', chain: '—', action: 'Paper session initialized', result: 'Completed', detail: 'Static demonstration session. No runtime, wallet vault, or provider is connected.' },
];
