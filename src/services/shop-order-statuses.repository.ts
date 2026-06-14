import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';

export interface ShopOrderStatusRecord {
  id: string;
  tenantId: string;
  shopId: string;
  externalStatusId: string;
  name: string;
  color: string | null;
  operationalStatus: string | null;
  isPaid: boolean;
  isCancelled: boolean;
  isReadyForInvoice: boolean;
  isInvoiceTarget: boolean;
  sortOrder: number;
  payloadJson: unknown;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type ShopOrderStatusRow = {
  id: string;
  tenant_id: string;
  shop_id: string;
  external_status_id: string;
  name: string;
  color: string | null;
  operational_status: string | null;
  is_paid: boolean;
  is_cancelled: boolean;
  is_ready_for_invoice: boolean;
  is_invoice_target: boolean;
  sort_order: number;
  payload_json: unknown;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export interface UpsertShopOrderStatusInput {
  tenantId: string;
  shopId: string;
  externalStatusId: string;
  name: string;
  color?: string | null;
  operationalStatus?: string | null;
  isPaid?: boolean;
  isCancelled?: boolean;
  sortOrder?: number;
  payloadJson?: unknown;
  lastSyncedAt?: Date | null;
}

export interface UpdateShopOrderStatusMappingInput {
  shopId: string;
  externalStatusId: string;
  operationalStatus?: string | null;
  isPaid?: boolean;
  isCancelled?: boolean;
  isReadyForInvoice?: boolean;
  isInvoiceTarget?: boolean;
}

function mapShopOrderStatusRow(row: ShopOrderStatusRow): ShopOrderStatusRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    externalStatusId: row.external_status_id,
    name: row.name,
    color: row.color,
    operationalStatus: row.operational_status,
    isPaid: row.is_paid,
    isCancelled: row.is_cancelled,
    isReadyForInvoice: row.is_ready_for_invoice,
    isInvoiceTarget: row.is_invoice_target,
    sortOrder: row.sort_order,
    payloadJson: row.payload_json,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listShopOrderStatusRecords(shopId: string): Promise<ShopOrderStatusRecord[]> {
  const rows = await prisma.$queryRaw<ShopOrderStatusRow[]>`
    SELECT
      id,
      tenant_id,
      shop_id,
      external_status_id,
      name,
      color,
      operational_status,
      is_paid,
      is_cancelled,
      is_ready_for_invoice,
      is_invoice_target,
      sort_order,
      payload_json,
      last_synced_at,
      created_at,
      updated_at
    FROM shop_order_statuses
    WHERE shop_id = ${shopId}
    ORDER BY sort_order ASC, name ASC
  `;

  return rows.map(mapShopOrderStatusRow);
}

export async function findShopOrderStatusRecord(
  shopId: string,
  externalStatusId: string,
): Promise<ShopOrderStatusRecord | null> {
  const rows = await prisma.$queryRaw<ShopOrderStatusRow[]>`
    SELECT
      id,
      tenant_id,
      shop_id,
      external_status_id,
      name,
      color,
      operational_status,
      is_paid,
      is_cancelled,
      is_ready_for_invoice,
      is_invoice_target,
      sort_order,
      payload_json,
      last_synced_at,
      created_at,
      updated_at
    FROM shop_order_statuses
    WHERE shop_id = ${shopId}
      AND external_status_id = ${externalStatusId}
    LIMIT 1
  `;

  return rows[0] ? mapShopOrderStatusRow(rows[0]) : null;
}

export async function upsertShopOrderStatusRecord(input: UpsertShopOrderStatusInput) {
  const payloadJson = JSON.stringify(input.payloadJson ?? null);
  const color = input.color ?? null;
  const operationalStatus = input.operationalStatus ?? null;
  const isPaid = input.isPaid ?? false;
  const isCancelled = input.isCancelled ?? false;
  const sortOrder = input.sortOrder ?? 0;
  const lastSyncedAt = input.lastSyncedAt ?? null;

  await prisma.$executeRaw`
    INSERT INTO shop_order_statuses (
      id,
      tenant_id,
      shop_id,
      external_status_id,
      name,
      color,
      operational_status,
      is_paid,
      is_cancelled,
      sort_order,
      payload_json,
      last_synced_at,
      created_at,
      updated_at
    )
    VALUES (
      ${randomUUID()},
      ${input.tenantId},
      ${input.shopId},
      ${input.externalStatusId},
      ${input.name},
      ${color},
      ${operationalStatus},
      ${isPaid},
      ${isCancelled},
      ${sortOrder},
      ${payloadJson}::jsonb,
      ${lastSyncedAt},
      NOW(),
      NOW()
    )
    ON CONFLICT (shop_id, external_status_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      color = EXCLUDED.color,
      is_paid = EXCLUDED.is_paid,
      is_cancelled = EXCLUDED.is_cancelled,
      sort_order = EXCLUDED.sort_order,
      payload_json = EXCLUDED.payload_json,
      last_synced_at = EXCLUDED.last_synced_at,
      updated_at = NOW()
  `;
}

export async function updateShopOrderStatusMappingRecord(input: UpdateShopOrderStatusMappingInput) {
  await prisma.$executeRaw`
    UPDATE shop_order_statuses
    SET
      operational_status = CASE
        WHEN ${input.operationalStatus === undefined} THEN operational_status
        ELSE ${input.operationalStatus ?? null}
      END,
      is_paid = CASE
        WHEN ${input.isPaid === undefined} THEN is_paid
        ELSE ${input.isPaid ?? false}
      END,
      is_cancelled = CASE
        WHEN ${input.isCancelled === undefined} THEN is_cancelled
        ELSE ${input.isCancelled ?? false}
      END,
      is_ready_for_invoice = CASE
        WHEN ${input.isReadyForInvoice === undefined} THEN is_ready_for_invoice
        ELSE ${input.isReadyForInvoice ?? false}
      END,
      is_invoice_target = CASE
        WHEN ${input.isInvoiceTarget === undefined} THEN is_invoice_target
        ELSE ${input.isInvoiceTarget ?? false}
      END,
      updated_at = NOW()
    WHERE shop_id = ${input.shopId}
      AND external_status_id = ${input.externalStatusId}
  `;
}
