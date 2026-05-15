export interface ShopStockClient {
  updateStockQuantity(externalProductId: string, quantity: number): Promise<void>;
  updateProductPrice?(externalProductId: string, price: number): Promise<void>;
  getProductInventorySnapshot?(externalProductId: string): Promise<ShopProductInventorySnapshot>;
}

export interface ShopProductInventorySnapshot {
  externalProductId: string;
  price?: number;
  stock?: number;
  stockAvailableId?: string;
}
