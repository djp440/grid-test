import fs from "fs";
import path from "path";
import toml from "@iarna/toml";
import dotenv from "dotenv";
import { AppConfig } from "../types/config";
import { logger } from "../utils/logger";

export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: AppConfig | null = null;

  private constructor() {
    dotenv.config(); // Load .env
  }

  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  public loadConfig(configPath: string = "config.toml"): AppConfig {
    if (this.config) {
      return this.config;
    }

    const fullPath = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Configuration file not found at: ${fullPath}`);
    }

    try {
      const tomlContent = fs.readFileSync(fullPath, "utf-8");
      const parsedConfig = toml.parse(tomlContent) as unknown as AppConfig;

      // Validate and Inject API Keys based on mode
      this.config = this.injectApiKeys(parsedConfig);

      logger.info(
        `Configuration loaded successfully. Mode: ${this.config.mode}`
      );
      return this.config;
    } catch (error) {
      logger.error("Failed to load configuration:", error);
      throw error;
    }
  }

  private injectApiKeys(config: AppConfig): AppConfig {
    const isReal = config.mode === "real";

    config.exchanges = config.exchanges.map(exchange => {
      if (exchange.name === "bitget") {
        if (isReal) {
          exchange.apiKey = process.env.BITGET_REAL_API_KEY;
          exchange.secret = process.env.BITGET_REAL_SECRET;
          exchange.password = process.env.BITGET_REAL_PASSWORD;
        } else {
          exchange.apiKey = process.env.BITGET_SIM_API_KEY;
          exchange.secret = process.env.BITGET_SIM_SECRET;
          exchange.password = process.env.BITGET_SIM_PASSWORD;
        }

        if (!exchange.apiKey || !exchange.secret || !exchange.password) {
          logger.warn(
            `Missing API credentials for ${exchange.name} in ${config.mode} mode.`
          );
        }
      }
      return exchange;
    });

    return config;
  }

  public getConfig(): AppConfig {
    if (!this.config) {
      throw new Error("Config not loaded. Call loadConfig() first.");
    }
    return this.config;
  }
}
