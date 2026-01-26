/// <reference lib="dom" />
import { Buffer } from 'node:buffer';

interface PrestaShopOrder {
  id: number;
  id_customer: number;
  id_cart: number;
  reference: string;
  current_state: number;
  total_paid: string;
  date_add: string;
  associations?: {
    order_rows?: Array<{
      id: number;
      product_id: number;
      product_attribute_id: number;
      product_quantity: number;
      product_name: string;
      product_reference: string;
    }>;
  };
}

interface PrestaShopCustomer {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
}

export interface PrestaShopOrderDetails {
  order: PrestaShopOrder;
  customer: PrestaShopCustomer;
  items: Array<{
    id: number;
    product_id: number;
    product_reference: string;
    product_name: string;
    quantity: number;
  }>;
}

export class PrestaShopClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    authType: 'WEB_SERVICE' | 'ADMIN_API';
    adminApiConfig?: {
      clientId: string;
      clientSecret: string;
      scopes: string[];
    };
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  private async fetchWebService<T>(endpoint: string): Promise<T> {
    const url = `${this.baseUrl}/api/${endpoint}${endpoint.includes('?') ? '&' : '?'}output_format=JSON`;
    const authHeader = 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64');

    console.log(`[PrestaShop] Requesting: ${endpoint}`);

    let response = await fetch(url, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    // Fallback: some hosts strip Authorization header
    if (!response.ok && response.status === 401) {
      console.log('[PrestaShop] Auth header failed, trying ws_key parameter');
      const urlWithKey = `${url}&ws_key=${encodeURIComponent(this.apiKey)}`;
      response = await fetch(urlWithKey, {
        headers: { Accept: 'application/json' },
      });
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[PrestaShop] Error ${response.status} for ${endpoint}:`, text.slice(0, 300));
      throw new Error(`PrestaShop API error: ${response.status} ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  async fetchOrders(params: {
    limit?: number;
    dateFrom?: string;
    currentState?: number;
  }): Promise<PrestaShopOrder[]> {
    const queryParams: string[] = [`limit=${params.limit || 50}`];
    if (params.dateFrom) {
      queryParams.push(`date_add>[${params.dateFrom}]`);
    }
    if (params.currentState) {
      queryParams.push(`current_state=${params.currentState}`);
    }

    const query = queryParams.join('&');
    const data = await this.fetchWebService<any>(`orders?${query}&display=full`);

    if (!data.orders) {
      return [];
    }

    // Handle both single order and array of orders
    const orders = Array.isArray(data.orders) ? data.orders : [data.orders];
    return orders;
  }

  async fetchOrderDetails(orderId: number): Promise<PrestaShopOrderDetails> {
    try {
      console.log(`[PrestaShop] Fetching order ${orderId} from: orders/${orderId}?display=full`);
      const orderData = await this.fetchWebService<any>(`orders/${orderId}?display=full`);
      
      console.log(`[PrestaShop] Raw response for order ${orderId}:`, JSON.stringify(orderData, null, 2));
      console.log(`[PrestaShop] Response keys:`, Object.keys(orderData));
      
      // PrestaShop returns orders as array even for single order request
      const order = orderData.order || (orderData.orders && orderData.orders[0]) || orderData;
      console.log(`[PrestaShop] Extracted order object:`, JSON.stringify(order, null, 2).substring(0, 500));
      console.log(`[PrestaShop] Order keys:`, Object.keys(order || {}));
      console.log(`[PrestaShop] id_customer value:`, order?.id_customer);

      if (!order || !order.id_customer) {
        console.error(`[PrestaShop] Invalid order data for ID ${orderId}`);
        console.error(`[PrestaShop] Full response:`, JSON.stringify(orderData, null, 2));
        throw new Error(`Invalid order data for ID ${orderId}`);
      }

      console.log(`[PrestaShop] Fetching customer ${order.id_customer}`);
      const customerData = await this.fetchWebService<any>(`customers/${order.id_customer}?display=full`);
      
      console.log(`[PrestaShop] Customer raw response:`, JSON.stringify(customerData, null, 2).substring(0, 1000));
      console.log(`[PrestaShop] Customer data keys:`, Object.keys(customerData));
      
      // Handle both single customer and array
      const customer = customerData.customer || 
                      (customerData.customers && customerData.customers[0]) || 
                      customerData;
      
      console.log(`[PrestaShop] Customer ${order.id_customer} email: "${customer.email}"`);
      console.log(`[PrestaShop] Customer ${order.id_customer} firstname: "${customer.firstname}"`);
      console.log(`[PrestaShop] Customer ${order.id_customer} lastname: "${customer.lastname}"`);

      // Fetch order items
      const items: Array<{
        id: number;
        product_id: number;
        product_reference: string;
        product_name: string;
        quantity: number;
      }> = [];

      if (order.associations?.order_rows) {
        for (const row of order.associations.order_rows) {
          items.push({
            id: row.id,
            product_id: row.product_id,
            product_reference: row.product_reference || '',
            product_name: row.product_name || '',
            quantity: row.product_quantity,
          });
        }
      }

      return {
        order,
        customer,
        items,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch order ${orderId} details: ${message}`);
    }
  }

  async addOrderNote(orderId: number, message: string): Promise<void> {
    // This would require order_histories endpoint
    // Implementation depends on PrestaShop version
    console.log(`Would add note to order ${orderId}: ${message}`);
  }
}
