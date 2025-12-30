import { ExchangeManager } from "./exchangeManager";
import { GridDirection } from "../types/grid";
import { logger } from "../utils/logger";

/**
 * 订单执行引擎
 * 专门处理 Bitget 合约在双向持仓模式下的下单逻辑
 */
export class OrderExecutor {
  private exchange: ExchangeManager;
  // 本地订单缓存：StratKey -> Set<OrderID>
  // 用于辅助 syncActiveOrders，防止在并发极高时重复挂单
  private localOrderCache: Record<string, Set<string>> = {};

  constructor() {
    this.exchange = ExchangeManager.getInstance();
  }

  /**
   * 获取策略缓存 Key
   */
  private getCacheKey(symbol: string, direction: GridDirection): string {
    return `${symbol}_${direction}`;
  }

  /**
   * 核心下单方法：执行网格订单
   * @param symbol 交易对
   * @param price 下单价格
   * @param amount 下单数量
   * @param direction 策略方向 (LONG/SHORT)
   * @param action 操作类型 (open/close)
   */
  public async placeGridOrder(
    symbol: string,
    price: number,
    amount: number,
    direction: GridDirection,
    action: "open" | "close"
  ) {
    /**
     * Bitget Hedge Mode (双向持仓) 映射规则说明:
     * 1. side 参数代表持仓方向 (Position Side):
     *    - 操作多头仓位 (Long Position): side 永远是 'buy'
     *    - 操作空头仓位 (Short Position): side 永远是 'sell'
     * 2. tradeSide 参数代表开平仓方向:
     *    - 开仓: 'open'
     *    - 平仓: 'close'
     * 3. Post Only: 强制 Maker，使用 timeInForce: 'post_only'
     */

    let side: "buy" | "sell";
    if (direction === GridDirection.LONG) {
      side = "buy";
    } else {
      side = "sell";
    }

    const params = {
      tradeSide: action,
      timeInForce: "post_only", // 确保是 Maker 挂单
    };

    try {
      logger.info(
        `[OrderExecutor] 尝试挂单: ${symbol} | 方向: ${direction} | 动作: ${action} | 价格: ${price} | 数量: ${amount}`
      );

      const order = await this.exchange.client.createOrder(
        symbol,
        "limit",
        side,
        amount,
        price,
        params
      );

      logger.info(`[OrderExecutor] 挂单成功: ID ${order.id}`);
      return order;
    } catch (error: any) {
      // 捕获 Post Only 导致的立即成交取消错误
      if (
        error.message.includes("Post only order") ||
        error.message.includes("post_only")
      ) {
        logger.warn(
          `[OrderExecutor] Post Only 挂单被取消 (价格可能已穿过): ${error.message}`
        );
        return null;
      }
      logger.error(`[OrderExecutor] 下单失败: ${error.message}`);
      // 抛出特定错误码，以便上层逻辑处理
      if (
        error.message.includes("22002") ||
        error.message.includes("No position to close")
      ) {
        error.code = "NO_POSITION";
      }
      throw error;
    }
  }

  /**
   * 执行市价建仓 (用于自动底仓构建)
   */
  public async placeMarketOrder(
    symbol: string,
    side: "buy" | "sell",
    amount: number
  ) {
    // 市价单，假设是开仓 (Initial Position)
    // Bitget Hedge Mode 需要 tradeSide
    const params = {
      tradeSide: "open",
    };

    try {
      logger.info(
        `[OrderExecutor] 执行市价建仓: ${symbol} | Side: ${side} | 数量: ${amount}`
      );
      const order = await this.exchange.client.createOrder(
        symbol,
        "market",
        side,
        amount,
        undefined, // Price undefined for market
        params
      );
      logger.info(`[OrderExecutor] 市价建仓成功: ID ${order.id}`);
      return order;
    } catch (error: any) {
      logger.error(`[OrderExecutor] 市价建仓失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 撤销指定交易对的所有活跃订单
   */
  public async cancelAllOrders(symbol: string) {
    try {
      logger.info(`[OrderExecutor] 正在撤销 ${symbol} 的所有挂单...`);
      // Bitget 支持批量撤单，ccxt 封装了 cancelAllOrders
      await this.exchange.client.cancelAllOrders(symbol);
      logger.info(`[OrderExecutor] ${symbol} 所有挂单已撤销`);
    } catch (error: any) {
      logger.error(`[OrderExecutor] 撤销订单失败: ${error.message}`);
      // 撤单失败通常不阻塞后续逻辑，记录错误即可
    }
  }

  /**
   * 闪电平仓 (Flash Close)
   * 针对指定交易对，立即平掉所有方向的仓位
   */
  public async flashClosePositions(symbol: string) {
    try {
      logger.info(`[OrderExecutor] 正在对 ${symbol} 执行闪电平仓...`);
      // Bitget 闪电平仓接口映射
      await this.exchange.client.privatePostMixOrderFlashClosePositions({
        symbol: this.exchange.getMarket(symbol).id,
      });
      logger.info(`[OrderExecutor] ${symbol} 闪电平仓指令已发送`);
    } catch (error: any) {
      // 如果报错是因为本来就没仓位，可以忽略
      if (error.message.includes("No position")) {
        logger.info(`[OrderExecutor] ${symbol} 无需平仓 (无活跃仓位)`);
      } else {
        logger.error(`[OrderExecutor] 闪电平仓失败: ${error.message}`);
      }
    }
  }

  /**
   * 同步活跃订单：精细化同步，优先使用 editOrder 减少 API 调用
   * @param symbol 交易对
   * @param direction 策略方向
   * @param targetLevels 目标挂单刻度
   */
  public async syncActiveOrders(
    symbol: string,
    direction: GridDirection,
    targetLevels: { price: number; amount: number; action: "open" | "close" }[]
  ) {
    try {
      const cacheKey = this.getCacheKey(symbol, direction);
      if (!this.localOrderCache[cacheKey]) {
        this.localOrderCache[cacheKey] = new Set();
      }

      // 1. 获取当前所有挂单
      const openOrders = await this.exchange.client.fetchOpenOrders(symbol);

      // 2. 筛选出属于当前策略方向的订单
      // 在 Bitget API 响应中，posSide 明确标识了持仓方向 ('long' 或 'short')
      const currentStrategyOrders = openOrders.filter((o: any) => {
        const targetPosSide =
          direction === GridDirection.LONG ? "long" : "short";
        // 兼容处理：Bitget 的 posSide 字段通常在 o.info 中
        const orderPosSide =
          o.info.posSide || (o.side === "buy" ? "long" : "short");
        return orderPosSide === targetPosSide;
      });

      // 2.5 同步本地缓存（移除那些已经不在 fetchOpenOrders 里的订单）
      const remoteIds = new Set(currentStrategyOrders.map((o: any) => o.id));
      for (const cachedId of this.localOrderCache[cacheKey]) {
        if (!remoteIds.has(cachedId)) {
          this.localOrderCache[cacheKey].delete(cachedId);
        }
      }

      // 3. 增量同步逻辑
      const ordersToKeep: any[] = [];
      const targetsToPlace: any[] = [];

      for (const target of targetLevels) {
        const existingOrder = currentStrategyOrders.find((o: any) => {
          const priceMatch =
            Math.abs(parseFloat(o.price) - target.price) < 0.00000001;
          const actionMatch = o.info.tradeSide === target.action;
          return priceMatch && actionMatch;
        });
        if (existingOrder) {
          ordersToKeep.push(existingOrder);
        } else {
          targetsToPlace.push(target);
        }
      }

      // 4. 准备批量操作队列
      const batchCreates: any[] = [];
      const ordersToCancel: string[] = [];

      // 所有不在“保留列表”中的旧单都需要撤销
      const ordersToDispose = currentStrategyOrders.filter(
        (o: any) => !ordersToKeep.includes(o)
      );
      for (const o of ordersToDispose) {
        ordersToCancel.push(o.id);
      }

      // 所有“待下单”的目标都需要批量创建
      for (const target of targetsToPlace) {
        batchCreates.push({
          symbol: symbol,
          type: "limit",
          side: direction === GridDirection.LONG ? "buy" : "sell",
          amount: target.amount,
          price: target.price,
          params: { tradeSide: target.action, timeInForce: "post_only" },
        });
      }

      // 5. 执行批量撤单 (Bitget 批量接口)
      if (ordersToCancel.length > 0) {
        logger.info(
          `[OrderExecutor] 批量撤销订单: ${ordersToCancel.length} 笔`
        );
        try {
          // Bitget 批量撤单接口：cancelOrders(ids, symbol)
          await this.exchange.client.cancelOrders(ordersToCancel, symbol);
        } catch (e: any) {
          logger.warn(
            `[OrderExecutor] 批量撤单失败，回退到循环单笔: ${e.message}`
          );
          for (const id of ordersToCancel) {
            this.exchange.client.cancelOrder(id, symbol).catch(() => {});
          }
        }
      }

      // 6. 执行批量创建 (Bitget Batch Create)
      if (batchCreates.length > 0) {
        logger.info(`[OrderExecutor] 批量创建订单: ${batchCreates.length} 笔`);
        try {
          const newOrders = await this.exchange.client.createOrders(
            batchCreates
          );
          // 将新创建的订单 ID 加入缓存
          if (Array.isArray(newOrders)) {
            for (const o of newOrders) {
              this.localOrderCache[cacheKey].add(o.id);
            }
          }
        } catch (e: any) {
          logger.error(`[OrderExecutor] 批量创建失败: ${e.message}`);
          // 捕获“无仓位”等特定错误并上抛
          if (
            e.message.includes("22002") ||
            e.message.includes("No position to close")
          ) {
            const err: any = new Error(e.message);
            err.code = "NO_POSITION";
            throw err;
          }
        }
      }
    } catch (error: any) {
      logger.error(`[OrderExecutor] 同步订单失败: ${error.message}`);
    }
  }
}
