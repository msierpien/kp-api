export interface ShopStockClient {
  updateStockQuantity(
    externalProductId: string,
    quantity: number,
    options?: ShopStockUpdateOptions,
  ): Promise<void>;
  updateProductPrice?(externalProductId: string, price: number): Promise<void>;
  getProductInventorySnapshot?(externalProductId: string): Promise<ShopProductInventorySnapshot>;
}

export interface ShopStockUpdateOptions {
  outOfStockBehavior?: 0 | 1 | 2;
  leadTimeDays?: number | null;
  warehouseAvailableAt?: string | null;
  availabilityPolicy?: 'IN_STOCK' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
}

export interface ShopProductInventorySnapshot {
  externalProductId: string;
  price?: number;
  stock?: number;
  stockAvailableId?: string;
  idShop?: string;
}
