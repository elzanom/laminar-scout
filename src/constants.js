export const PROGRAM_IDS = {
  DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  SYSTEM: '11111111111111111111111111111111',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};

export const KNOWN_MINTS = {
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

export const POSITION_V2 = {
  DISCRIMINATOR: [117, 176, 212, 199, 245, 180, 133, 182],
  ACCOUNT_SIZE: 8120,
  OFFSET_LB_PAIR: 8,
  OFFSET_OWNER: 40,
  OFFSET_LOWER_BIN_ID: 7912,
  OFFSET_UPPER_BIN_ID: 7916,
};

export const INSTRUCTION_DISCRIMINATORS = {
  add_liquidity: [181, 157, 89, 67, 143, 182, 52, 72],
  add_liquidity2: [228, 162, 78, 28, 70, 219, 116, 115],
  add_liquidity_by_strategy: [7, 3, 150, 127, 148, 40, 61, 200],
  add_liquidity_by_strategy2: [3, 221, 149, 218, 111, 141, 118, 213],
  add_liquidity_by_strategy_one_side: [41, 5, 238, 175, 100, 225, 6, 205],
  add_liquidity_by_weight: [28, 140, 238, 99, 231, 162, 21, 149],
  add_liquidity_by_weight2: [209, 59, 63, 91, 111, 200, 153, 228],
  add_liquidity_one_side: [94, 155, 103, 151, 70, 95, 220, 165],
  add_liquidity_one_side_precise: [161, 194, 103, 84, 171, 71, 250, 154],
  add_liquidity_one_side_precise2: [33, 51, 163, 201, 117, 98, 125, 231],

  remove_liquidity: [80, 85, 209, 72, 24, 206, 177, 108],
  remove_liquidity2: [230, 215, 82, 127, 241, 101, 227, 146],
  remove_liquidity_by_range: [26, 82, 102, 152, 240, 74, 105, 26],
  remove_liquidity_by_range2: [204, 2, 195, 145, 53, 145, 145, 205],

  claim_fee: [169, 32, 79, 137, 136, 232, 70, 137],
  claim_fee2: [112, 191, 101, 171, 28, 144, 127, 187],
  claim_reward: [149, 95, 181, 242, 94, 90, 158, 162],
  claim_reward2: [190, 3, 127, 119, 178, 87, 157, 183],

  initialize_bin_array: [35, 86, 19, 185, 78, 212, 75, 211],
  initialize_bin_array_bitmap_extension: [47, 157, 226, 180, 12, 240, 33, 71],
};

export const POSITION_LIFECYCLE_INSTRUCTIONS = [
  'initialize_position',
  'initialize_position2',
  'initialize_position_pda',
  'initialize_position_by_operator',
  'close_position',
  'close_position2',
  'close_position_if_empty',
  'increase_position_length',
  'increase_position_length2',
  'decrease_position_length',
  'update_position_operator',
];

export const DISCRIMINATOR_SET = (() => {
  const m = new Map();
  for (const [name, disc] of Object.entries(INSTRUCTION_DISCRIMINATORS)) {
    m.set(disc.join(','), name);
  }
  return m;
})();

export function classifyInstruction(discBytes) {
  if (!discBytes || discBytes.length < 8) return null;
  return DISCRIMINATOR_SET.get(discBytes.slice(0, 8).join(',')) || null;
}

export function isAddLiquidity(name) {
  return typeof name === 'string' && name.startsWith('add_liquidity');
}

export function isRemoveLiquidity(name) {
  return typeof name === 'string' && name.startsWith('remove_liquidity');
}

export function isClaimFee(name) {
  return typeof name === 'string' && (name === 'claim_fee' || name === 'claim_fee2');
}

export function isClaimReward(name) {
  return typeof name === 'string' && (name === 'claim_reward' || name === 'claim_reward2');
}