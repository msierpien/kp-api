export interface ShopStockClient {
  updateStockQuantity(externalProductId: string, quantity: number): Promise<void>;
  updateProductPrice?(externalProductId: string, price: number): Promise<void>;
}
