/**
 * Schemat nadpisan layoutu (zmian klienta w portalu) zyje w pakiecie
 * @msierpien/kp-template-core - API waliduje dokladnie to, co wysyla portal.
 *
 * Uwaga przy dodawaniu pol: `z.object` po cichu usuwa klucze spoza schematu,
 * wiec nowe pole trzeba dopisac w pakiecie i wydac nowa wersje. Wyciete klucze
 * raportuje `parseLayoutOverrides`, a trasy publiczne loguja je jako ostrzezenie.
 */
export * from '@msierpien/kp-template-core';
