import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export default fp(async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'KP Personalization API',
        description: 'API do zarządzania personalizacją produktów e-commerce',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
        schemas: {
          ErrorResponse: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'auth', description: 'Autentykacja i autoryzacja' },
        { name: 'personalization', description: 'Portal klienta — personalizacja produktów (publiczne)' },
        { name: 'cases', description: 'Zarządzanie case\'ami personalizacji' },
        { name: 'orders', description: 'Zamówienia' },
        { name: 'shops', description: 'Integracje z platformami e-commerce' },
        { name: 'templates', description: 'Szablony personalizacji' },
        { name: 'personalized-products', description: 'Mapowanie SKU → szablon' },
        { name: 'warehouse', description: 'Magazyn: produkty, dokumenty, stany, EAN i skaner' },
        { name: 'warehouse-catalogs', description: 'Katalogi produktów magazynowych' },
        { name: 'warehouse-diagnostics', description: 'Diagnostyka magazynu: logi synchronizacji, ruchy i rozbieżności stanów' },
        { name: 'wholesale', description: 'Hurtownie: providery CSV, mapowania produktów i logi sync' },
        { name: 'stock-sync', description: 'Publikacja stanów i dostępności produktów magazynowych do sklepów' },
        { name: 'price-sync', description: 'Synchronizacja cen sprzedaży produktów magazynowych do sklepów' },
        { name: 'shop-mappings', description: 'Mapowanie produktów sklepów do produktów magazynowych' },
        { name: 'email', description: 'Email — wysyłka i ustawienia SMTP' },
        { name: 'render-jobs', description: 'Zadania renderowania PDF' },
        { name: 'automations', description: 'Automatyzacje workflow' },
        { name: 'fonts', description: 'Czcionki globalne' },
        { name: 'sync-logs', description: 'Logi synchronizacji zamówień' },
        { name: 'stats', description: 'Statystyki' },
        { name: 'queues', description: 'Zarządzanie kolejkami BullMQ (tylko SUPER_ADMIN)' },
        { name: 'tenants', description: 'Zarządzanie tenantami (tylko SUPER_ADMIN)' },
        { name: 'users', description: 'Zarządzanie użytkownikami' },
        { name: 'storage', description: 'Zarządzanie plikami (tylko SUPER_ADMIN)' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: false,
  });
});
