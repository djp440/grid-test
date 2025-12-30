# Grid Trading System (Bitget/Binance)

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Runtime-Node.js-green.svg)](https://nodejs.org/)
[![CCXT Pro](https://img.shields.io/badge/Library-CCXT%20Pro-yellow.svg)](https://ccxt.pro/)

这是一个为 Bitget 和 Binance 交易所设计的高性能、低延迟现货/合约网格交易机器人。

## 🛠 技术栈

*   **语言**: TypeScript (Strict Mode)
*   **运行时**: Node.js
*   **核心库**: `ccxt` (Pro capabilities required for WebSocket)
*   **架构模式**: Event Emitter, State Machine (GridContext)

## 📂 项目结构

```text
src/
├── config/           # 配置加载逻辑 (TOML/Env)
├── exchange/         # 交易所交互层
│   ├── exchangeManager.ts  # CCXT 实例单例管理
│   └── orderExecutor.ts    # 下单逻辑 (处理 Post-Only, Hedge Mode)
├── logic/            # 核心业务逻辑
│   ├── botEngine.ts        # 机器人主引擎 (事件处理)
│   └── gridContext.ts      # 网格状态管理 (计算刻度, 持久化 CSV)
├── types/            # TypeScript 类型定义
├── utils/            # 工具函数 (Logger, Math)
└── index.ts          # 入口文件
```

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境

1.  复制环境变量文件：
    ```bash
    cp .env.example .env
    ```
2.  在 `.env` 中填入 API Key：
    ```ini
    API_KEY=your_api_key
    API_SECRET=your_api_secret
    API_PASSWORD=your_api_password
    ```
3.  配置交易参数 (参考 `config.toml` 或代码中的默认配置)。

### 3. 运行

**开发模式 (TS-Node):**
```bash
npm run dev
```

**生产模式:**
```bash
npm run build
npm start
```

## 🧪 测试

测试脚本位于 `test/` 目录下。

```bash
# 测试交易所连接
npm run test:conn

# 测试网格计算逻辑
npm run test:grid
```

## 📝 状态持久化

网格状态会自动保存为 CSV 文件至 `temp/` 目录。
*   文件名格式: `grid_{symbol}_{direction}.csv`
*   重启时，系统会优先读取存在的 CSV 以恢复之前的网格状态，防止重复开单或逻辑重置。

## ⚠️ 风险提示

*   本项目涉及真金白银交易，请务必在实盘前使用小资金或测试网进行充分测试。
*   **Stop Loss** (止损) 机制必须在策略层面严格执行。
