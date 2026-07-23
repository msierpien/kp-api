import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('API version contract', () => {
  it('publishes the admin compatibility contract expected by kp-admin', async () => {
    const {
      API_CONTRACT_VERSION,
      API_VERSION,
      COMPATIBILITY_PROFILE,
      MIN_ADMIN_CONTRACT_VERSION,
      MIN_ADMIN_VERSION,
      getAdminCompatibility,
      readAdminVersionClient,
      getApplicationVersionInfo,
    } = await import('../src/services/ops/version.service');

    assert.equal(API_VERSION, '1.6.15');
    assert.equal(API_CONTRACT_VERSION, 5);
    assert.equal(MIN_ADMIN_CONTRACT_VERSION, 3);
    assert.equal(MIN_ADMIN_VERSION, '0.6.0');
    assert.equal(COMPATIBILITY_PROFILE, 'kp-admin-api');

    const info = getApplicationVersionInfo('test');
    assert.equal(info.version, '1.6.15');
    assert.equal(info.compatibilityProfile, 'kp-admin-api');
    assert.equal(info.apiContractVersion, 5);
    assert.equal(info.minAdminContractVersion, 3);
    assert.equal(info.minAdminVersion, '0.6.0');
    assert.ok(info.features.includes('orders-list-v1'));
    assert.ok(info.features.includes('deployment-build-metadata-v1'));
    assert.ok(info.features.includes('docker-production-deploy-v1'));
    assert.ok(info.features.includes('invoice-prestashop-delivery-v1'));
    assert.ok(info.features.includes('order-status-mapping-v1'));
    assert.ok(info.features.includes('personalization-case-print-package-v1'));
    assert.ok(info.features.includes('personalization-case-answer-validation-v1'));
    assert.ok(info.features.includes('personalization-answer-row-cleanup-v1'));
    assert.ok(info.features.includes('personalization-case-render-job-status-v1'));
    assert.ok(info.features.includes('personalization-case-queue-summary-v1'));
    assert.ok(info.features.includes('personalization-case-update-detail-response-v1'));
    assert.ok(info.features.includes('personalization-field-scope-canonical-v1'));
    assert.ok(info.features.includes('personalization-structured-answers-v1'));
    assert.ok(info.features.includes('personalization-template-create-layout-v1'));
    assert.ok(info.features.includes('personalization-template-card-summary-v1'));
    assert.ok(info.features.includes('personalization-template-layout-warnings-v1'));
    assert.ok(info.features.includes('personalization-template-form-layout-cascade-v1'));
    assert.ok(info.features.includes('personalization-template-mm-canonical-v1'));
    assert.ok(info.features.includes('personalization-template-mm-layout-v1'));
    assert.ok(info.features.includes('personalization-template-simple-slots-v1'));
    assert.ok(info.features.includes('product-card-content-v1'));
    assert.ok(info.features.includes('prestashop-admin-connector-bridge-v1'));
    assert.ok(info.features.includes('prestashop-admin-connector-carrier-restrictions-v1'));
    assert.ok(info.features.includes('prestashop-carrier-size-restrictions-v1'));
    assert.ok(info.features.includes('public-invoice-pdf-v1'));
    assert.ok(info.features.includes('warehouse-full-inventory-v1'));
    assert.ok(info.features.includes('warehouse-inventory-scanner-v1'));
    assert.ok(info.features.includes('warehouse-mixed-availability-v1'));
    assert.ok(info.features.includes('warehouse-stock-tracking-v1'));

    const client = readAdminVersionClient({
      'x-admin-version': '0.7.5',
      'x-admin-api-contract-version': '5',
      'x-admin-compatibility-profile': 'kp-admin-api',
    });
    assert.deepEqual(client, {
      version: '0.7.5',
      apiContractVersion: 5,
      compatibilityProfile: 'kp-admin-api',
    });
    assert.equal(getAdminCompatibility(client, 'test').compatible, true);

    assert.equal(
      getAdminCompatibility({ ...client, apiContractVersion: 6 }, 'test').label,
      'Niezgodny kontrakt'
    );
    assert.equal(
      getAdminCompatibility({ ...client, compatibilityProfile: 'admin-local' }, 'test').label,
      'Niezgodny profil'
    );
    assert.equal(readAdminVersionClient({}).apiContractVersion, null);
    assert.equal(
      getAdminCompatibility({ ...client, apiContractVersion: null }, 'test').label,
      'Brak kontraktu'
    );
  });
});
