export enum GridDirection {
  LONG = "LONG",
  SHORT = "SHORT",
}

/**
 * 网格配置接口
 */
export interface GridConfig {
  symbol: string; // 交易对，例如 BTC/USDT:USDT
  direction: GridDirection; // 方向
  leverage: number; // 杠杆
  upperPrice: number; // 网格上限
  lowerPrice: number; // 网格下限
  gridSpread: number; // 网格间距百分比 (例如 0.01 代表 1%)
  quantityPerGrid: number; // 每格下单数量
}

/**
 * 网格层级数据结构 (对应 CSV 行)
 */
export interface GridLevel {
  index: number; // 索引
  price: number; // 价格刻度
  buyOrderId: string; // 当前在该价格挂的买单 ID (空字符串表示无)
  sellOrderId: string; // 当前在该价格挂的卖单 ID (空字符串表示无)
}
