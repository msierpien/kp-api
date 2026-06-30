export interface ShopStockClient {
  updateStockQuantity(
    externalProductId: string,
    quantity: number,
    options?: ShopStockUpdateOptions,
  ): Promise<void>;
  updateProductPrice?(externalProductId: string, price: number, options?: ShopPriceUpdateOptions): Promise<void>;
  getProductInventorySnapshot?(externalProductId: string): Promise<ShopProductInventorySnapshot>;
}

export interface ShopPriceUpdateOptions {
  wholesalePrice?: number | null;
}

export interface ShopStockUpdateOptions {
  outOfStockBehavior?: 0 | 1 | 2;
  leadTimeDays?: number | null;
  warehouseAvailableAt?: string | null;
  availabilityPolicy?: 'IN_STOCK' | 'IN_STOCK_WITH_BACKORDER' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
  active?: boolean;
}

export interface ShopProductInventorySnapshot {
  externalProductId: string;
  price?: number;
  stock?: number;
  stockAvailableId?: string;
  idShop?: string;
  outOfStockBehavior?: number | null;
  availableForOrder?: boolean | null;
  showPrice?: boolean | null;
  leadTimeDays?: number | null;
  effectiveLeadTimeDays?: number | null;
  nativeAvailableNow?: string | null;
  nativeAvailableLater?: string | null;
  etaLabel?: string | null;
  availabilityPolicy?: 'IN_STOCK' | 'IN_STOCK_WITH_BACKORDER' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK' | null;
  etaDiagnosticsAvailable?: boolean;
}
