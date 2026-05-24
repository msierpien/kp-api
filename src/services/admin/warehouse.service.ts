export type {
  BulkDeleteProductsInput,
  BulkDeleteProductsResult,
  BulkUpdateProductsInput,
  BulkUpdateProductsResult,
  CreateProductInput,
  ProductsQuery,
  UpdateProductInput,
} from './warehouse-products.service';
export {
  bulkDeleteProducts,
  bulkUpdateProducts,
  createProduct,
  deleteProduct,
  getProductById,
  getProducts,
  updateProduct,
} from './warehouse-products.service';

export type {
  CancelDocumentInput,
  CreateDocumentInput,
  CreateWzForOrderResult,
  DocumentItemInput,
  DocumentsQuery,
  DocumentType,
  UpdateDocumentInput,
  UpdateDocumentItemInput,
} from './warehouse-documents.service';
export {
  cancelDocument,
  confirmDocument,
  createDocument,
  createWzForOrder,
  deleteDocument,
  deleteDocumentItem,
  getDocumentById,
  getDocuments,
  mergeDocumentItem,
  shouldAutoCreateWzForTenant,
  updateDocument,
  updateDocumentItem,
} from './warehouse-documents.service';
