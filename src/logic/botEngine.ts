import { ExchangeManager } from "../exchange/exchangeManager";
import { OrderExecutor } from "../exchange/orderExecutor";
import { GridContext } from "./gridContext";
import { ConfigLoader } from "../config/configLoader";
import { logger } from "../utils/logger";
import { GridDirection } from "../types/grid";

/**
 * BotEngine 核心引擎
 * 负责管理网格策略的生命周期，处理 WebSocket 事件驱动逻辑
 */
export class BotEngine {
  private exchange: ExchangeManager;
  private executor: OrderExecutor;
  private gridContexts: GridContext[] = [];
  private isRunning: boolean = false;
  // 记录每个策略当前的锚点索引 (Anchor Index)
  private anchorIndices: Record<string, number> = {};
  // 记录每个策略是否因为“无仓位”而暂时禁用了平仓挂单
  private isCloseDisabled: Record<string, boolean> = {};
  // 辅助函数：生成策略的唯一标识 Key
  private getStratKey(symbol: string, direction: GridDirection): string {
    return `${symbol}_${direction}`;
  }

  constructor() {
    this.exchange = ExchangeManager.getInstance();
    this.executor = new OrderExecutor();
  }

  /**
   * 启动引擎
   */
  public async start(): Promise<void> {
    try {
      logger.info("[BotEngine] 正在启动引擎...");

      // 1. 初始化交易所连接
      await this.exchange.initConnection();

      // 2. 加载网格配置
      const config = ConfigLoader.getInstance().getConfig();

      // 为每个启用的策略初始化 GridContext
      for (const strat of config.strategies) {
        const ctx = new GridContext(strat);
        await ctx.initialize();
        this.gridContexts.push(ctx);

        // 初始挂单同步
        await this.initialPositioning(ctx);
      }

      this.isRunning = true;
      logger.info("[BotEngine] 引擎启动成功，开始监听市场事件...");
      // 3. 启动事件监听循环 (不阻塞)
      this.watchOrdersLoop();
      // 为每个策略启动独立的并行价格监听协程
      for (const ctx of this.gridContexts) {
        this.watchTickerLoop(ctx).catch(e => {
          logger.error(
            `[BotEngine] [${ctx.getConfig().symbol}] 价格监听协程崩溃: ${
              e.message
            }`
          );
        });
      }
    } catch (error: any) {
      logger.error(`[BotEngine] 启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 初始挂单：根据当前价格挂出第一组单
   */
  private async initialPositioning(ctx: GridContext): Promise<void> {
    const config = ctx.getConfig();
    const ticker = await this.exchange.client.fetchTicker(config.symbol);
    const currentPrice = ticker.last;

    logger.info(
      `[BotEngine] [${config.symbol}] 初始价格: ${currentPrice}，正在寻找初始锚点...`
    );

    const nearest = ctx.getNearestLevels(currentPrice);
    if (!nearest) {
      logger.warn(`[BotEngine] [${config.symbol}] 初始价格超出网格范围`);
      return;
    }

    // 初始锚点设为当前最接近的下边界索引
    const stratKey = this.getStratKey(config.symbol, config.direction);
    this.anchorIndices[stratKey] = nearest[0].index;
    await this.refreshGridOrdersByAnchor(ctx);
  }

  /**
   * 核心逻辑：基于锚点索引 (Anchor Index) 刷新挂单
   */
  private async refreshGridOrdersByAnchor(ctx: GridContext): Promise<void> {
    const config = ctx.getConfig();
    const stratKey = this.getStratKey(config.symbol, config.direction);
    const anchorIndex = this.anchorIndices[stratKey];
    const levels = ctx.getLevels();

    if (anchorIndex === undefined) return;

    // 1. 移除前置 fetchPositions，提高响应速度
    // 2. 计算挂单窗口
    const appConfig = ConfigLoader.getInstance().getConfig();
    const windowSize = appConfig.default.order_window || 1;

    const targets = [];

    // 下方挂单窗口 (买单区)
    for (let i = 1; i <= windowSize; i++) {
      const idx = anchorIndex - i;
      if (idx < 0) break;

      targets.push({
        price: levels[idx].price,
        amount: config.quantityPerGrid,
        action:
          config.direction === GridDirection.LONG
            ? ("open" as const)
            : ("close" as const),
      });
    }

    // 上方挂单窗口 (卖单区)
    for (let i = 1; i <= windowSize; i++) {
      const idx = anchorIndex + i;
      if (idx >= levels.length) break;

      // 如果是 LONG 策略的平仓单，且当前未被禁用，则尝试挂单
      const isLongClose = config.direction === GridDirection.LONG;
      if (isLongClose && this.isCloseDisabled[stratKey]) {
        continue;
      }

      targets.push({
        price: levels[idx].price,
        amount: config.quantityPerGrid,
        action: isLongClose ? ("close" as const) : ("open" as const),
      });
    }
    // 下方挂单窗口中的平仓单 (SHORT 策略)
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (config.direction === GridDirection.SHORT && t.action === "close") {
        if (this.isCloseDisabled[stratKey]) {
          targets.splice(i, 1);
          i--;
        }
      }
    }

    logger.info(
      `[BotEngine] [${config.symbol}] [${config.direction}] 锚点: ${anchorIndex} (${levels[anchorIndex].price}) | 执行同步...`
    );
    try {
      await this.executor.syncActiveOrders(
        config.symbol,
        config.direction,
        targets
      );
    } catch (error: any) {
      if (error.code === "NO_POSITION") {
        logger.warn(
          `[BotEngine] [${config.symbol}] [${config.direction}] 检测到无仓位平仓报错，暂时禁用平仓挂单`
        );
        this.isCloseDisabled[stratKey] = true;
        // 立即重试一次同步（此时会过滤掉平仓单）
        await this.refreshGridOrdersByAnchor(ctx);
      } else {
        throw error;
      }
    }
  }

  /**
   * WebSocket 订单监听循环
   */
  private async watchOrdersLoop(): Promise<void> {
    logger.info("[BotEngine] 启动 watchOrders 监听任务...");

    // 显式激活每个 symbol 的订单订阅
    for (const ctx of this.gridContexts) {
      const symbol = ctx.getConfig().symbol;
      this.exchange.client.watchOrders(symbol).catch((e: any) => {
        logger.error(`[BotEngine] 订阅 ${symbol} 订单失败: ${e.message}`);
      });
    }

    while (this.isRunning) {
      try {
        // 监听订单更新
        const orders = await this.exchange.client.watchOrders();

        if (!orders || orders.length === 0) continue;

        for (const order of orders) {
          // 增加调试日志，捕获所有状态变更
          logger.info(
            `[Debug] 收到订单推送: ${order.symbol} | ID: ${order.id} | 状态: ${order.status} | 成交量: ${order.filled}/${order.amount}`
          );

          // 处理已成交 (filled) 或 部分成交且已关闭 的订单
          const isFilled = order.status === "filled";
          const isPartiallyFilledClosed =
            order.status === "closed" && order.filled > 0;

          if (!isFilled && !isPartiallyFilledClosed) continue;

          // 1. 查找该 symbol 下的所有相关策略 (联动响应)
          const relatedContexts = this.gridContexts.filter(
            c => c.getConfig().symbol === order.symbol
          );
          if (relatedContexts.length === 0) continue;

          logger.info(
            `[BotEngine] 确认成交: ${order.symbol} | ${order.side} | 价格: ${
              order.average || order.price
            } | 状态: ${order.status} | 联动刷新策略数: ${
              relatedContexts.length
            }`
          );

          // 2. 确定锚定参考价
          const appConfig = ConfigLoader.getInstance().getConfig();
          let referencePrice = order.price;

          // 如果开启了跟随市价，则尝试获取最新 Ticker 价格作为锚定基准
          if (appConfig.default.follow_market_on_fill) {
            try {
              const ticker = await this.exchange.client.fetchTicker(
                order.symbol
              );
              referencePrice = ticker.last;
              logger.info(
                `[BotEngine] [${order.symbol}] 开启成交联动跟随，锚定基准: 成交价 ${order.price} -> 最新价 ${referencePrice}`
              );
            } catch (e) {
              logger.warn(
                `[BotEngine] 获取最新价失败，回退到成交价锚定: ${order.price}`
              );
            }
          }

          // 3. 并发刷新所有相关策略
          await Promise.all(
            relatedContexts.map(async ctx => {
              const config = ctx.getConfig();
              const stratKey = this.getStratKey(
                config.symbol,
                config.direction
              );

              const nearest = ctx.getNearestLevels(referencePrice);
              if (nearest) {
                const newAnchor =
                  Math.abs(nearest[0].price - referencePrice) <
                  Math.abs(nearest[1].price - referencePrice)
                    ? nearest[0].index
                    : nearest[1].index;

                // 更新锚点（引入利润保护约束）
                const oldAnchor = this.anchorIndices[stratKey];
                let finalAnchor = newAnchor;

                // 只有触发成交的那个策略才需要利润保护约束（防止 0 利润挂单）
                const isTriggeringStrat =
                  (order.side === "buy" &&
                    config.direction === GridDirection.LONG) ||
                  (order.side === "sell" &&
                    config.direction === GridDirection.SHORT);

                if (isTriggeringStrat) {
                  const filledNearest = ctx.getNearestLevels(order.price);
                  if (filledNearest) {
                    const filledIdx =
                      Math.abs(filledNearest[0].price - order.price) <
                      Math.abs(filledNearest[1].price - order.price)
                        ? filledNearest[0].index
                        : filledNearest[1].index;

                    // 获取订单的 tradeSide (开/平)
                    const tradeSide = order.info.tradeSide;

                    if (tradeSide === "open") {
                      if (config.direction === GridDirection.LONG) {
                        // 开多后，锚点不能低于买入位，确保平多单在上方
                        finalAnchor = Math.max(newAnchor, filledIdx);
                      } else {
                        // 开空后，锚点不能高于卖出位，确保平空单在下方
                        finalAnchor = Math.min(newAnchor, filledIdx);
                      }
                    }
                  }
                }

                this.anchorIndices[stratKey] = finalAnchor;

                // 只有当锚点确实发生了位移，或者正是成交方，才执行同步操作
                if (newAnchor !== oldAnchor || isTriggeringStrat) {
                  logger.info(
                    `[BotEngine] [${config.symbol}] [${config.direction}] 联动更新锚点: ${oldAnchor} -> ${newAnchor}`
                  );

                  // 如果有成交，说明可能产生了新仓位，重置平仓禁用状态
                  if (isTriggeringStrat && this.isCloseDisabled[stratKey]) {
                    this.isCloseDisabled[stratKey] = false;
                  }

                  await this.refreshGridOrdersByAnchor(ctx);
                }
              }
            })
          );
        }
      } catch (error: any) {
        logger.error(`[BotEngine] watchOrders 异常: ${error.message}`);
        // 避免死循环瞬间消耗 CPU，等待一秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 并行价格监听循环：每个策略独立运行，实现积极锚点追随
   */
  private async watchTickerLoop(ctx: GridContext): Promise<void> {
    const config = ctx.getConfig();
    const stratKey = this.getStratKey(config.symbol, config.direction);

    while (this.isRunning) {
      try {
        const ticker = await this.exchange.client.watchTicker(config.symbol);
        const currentPrice = ticker.last;

        const anchorIdx = this.anchorIndices[stratKey];
        if (anchorIdx === undefined) continue;

        const levels = ctx.getLevels();
        const anchorPrice = levels[anchorIdx].price;
        const gridDiff = levels[1].price - levels[0].price;

        /**
         * 积极追随逻辑：
         * 只要价格超出了当前锚点上下最近的一个刻度 (gridDiff * 1.0)，
         * 且没有触发成交（成交会通过 watchOrders 更新锚点），就执行重置。
         */
        if (Math.abs(currentPrice - anchorPrice) > gridDiff * 1.05) {
          const nearest = ctx.getNearestLevels(currentPrice);
          if (nearest) {
            // 选取最接近当前价格的刻度作为新锚点
            const newAnchor =
              Math.abs(nearest[0].price - currentPrice) <
              Math.abs(nearest[1].price - currentPrice)
                ? nearest[0].index
                : nearest[1].index;

            if (newAnchor !== anchorIdx) {
              logger.info(
                `[BotEngine] [${config.symbol}] [${config.direction}] 价格漂移 (${currentPrice})，积极重置锚点: ${anchorIdx} -> ${newAnchor}`
              );
              this.anchorIndices[stratKey] = newAnchor;
              await this.refreshGridOrdersByAnchor(ctx);
            }
          }
        }
      } catch (error: any) {
        logger.error(
          `[BotEngine] [${config.symbol}] watchTicker 异常: ${error.message}`
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 停止引擎
   */
  /**
   * 停止引擎并根据配置执行清理
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    logger.info("[BotEngine] 引擎正在停止，开始执行清理逻辑...");

    const appConfig = ConfigLoader.getInstance().getConfig();
    const processedSymbols = new Set<string>();

    for (const ctx of this.gridContexts) {
      const symbol = ctx.getConfig().symbol;
      if (processedSymbols.has(symbol)) continue;

      // 1. 自动撤单
      if (appConfig.default.cancel_all_on_stop) {
        await this.executor.cancelAllOrders(symbol);
      }

      // 2. 自动平仓
      if (appConfig.default.close_all_on_stop) {
        await this.executor.flashClosePositions(symbol);
      }

      processedSymbols.add(symbol);
    }

    logger.info("[BotEngine] 清理逻辑执行完毕，引擎已关闭");
  }
}
