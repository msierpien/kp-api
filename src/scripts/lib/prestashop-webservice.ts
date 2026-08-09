/**
 * Minimalny klient webservice PrestaShop na potrzeby skryptow zakladajacych
 * karty produktow.
 *
 * `services/prestashop/prestashop-client.ts` obsluguje zamowienia, kategorie
 * i prosty produkt - tutaj potrzebujemy tez atrybutow, kombinacji, cech
 * i podmiany pol na istniejacej karcie, wiec skrypty dostaja wlasny, cienki
 * dostep do API. Kod produkcyjny z tego nie korzysta.
 */
import fs from 'fs'
import path from 'path'

export const LANGUAGE_ID = '1'

export type PrestaShopCredentials = { baseUrl: string; apiKey: string }

export function prestaShopApi({ baseUrl, apiKey }: PrestaShopCredentials) {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

  async function request(endpoint: string, init: RequestInit = {}, format: 'JSON' | 'XML' = 'JSON') {
    const separator = endpoint.includes('?') ? '&' : '?'
    const url = `${root}/api/${endpoint}${format === 'JSON' ? `${separator}output_format=JSON` : ''}`
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: auth,
        Accept: format === 'JSON' ? 'application/json' : 'application/xml',
        ...(init.headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${init.method || 'GET'} ${endpoint} -> ${response.status}: ${text.slice(0, 600)}`)
    }
    return text
  }

  return {
    baseUrl: root,

    async getJson<T = any>(endpoint: string): Promise<T> {
      const text = await request(endpoint)
      return text ? JSON.parse(text) : ({} as T)
    },

    async getXml(endpoint: string) {
      return request(endpoint, {}, 'XML')
    },

    async sendXml(endpoint: string, method: 'POST' | 'PUT', body: string) {
      return request(endpoint, { method, body, headers: { 'Content-Type': 'application/xml' } }, 'XML')
    },

    async deleteResource(endpoint: string) {
      await request(endpoint, { method: 'DELETE' }, 'XML')
    },

    async uploadImage(productId: string, filePath: string) {
      const buffer = fs.readFileSync(filePath)
      const form = new FormData()
      const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      form.append('image', new Blob([buffer], { type: mimeType }), path.basename(filePath))

      const response = await fetch(`${root}/api/images/products/${productId}`, {
        method: 'POST',
        headers: { Authorization: auth },
        body: form,
      })
      const text = await response.text()
      // PrestaShop odrzuca pliki powyzej 2000 KB - zdjecia produktowe zapisujemy
      // jako JPEG wlasnie dlatego.
      if (!response.ok) throw new Error(`upload zdjecia -> ${response.status}: ${text.slice(0, 400)}`)
      return text
    },
  }
}

export type PrestaShopApi = ReturnType<typeof prestaShopApi>

export const cdata = (value: string) => value.replace(/]]>/g, ']]]]><![CDATA[>')

/** Pierwsza wartosc pola z odpowiedzi XML (CDATA albo goly tekst). */
export function xmlValue(text: string, tag: string) {
  return (
    text.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:]]>)?\\s*</${tag}>`))?.[1]?.trim() ?? ''
  )
}

/** Podmienia zawartosc pojedynczego pola w XML zasobu. */
export function setTag(xml: string, tag: string, value: string) {
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`)
  const replacement = `<${tag}><![CDATA[${cdata(value)}]]></${tag}>`
  return pattern.test(xml) ? xml.replace(pattern, replacement) : xml
}

/** Podmienia pole wielojezyczne (sklep ma jeden jezyk - pl). */
export function setLangTag(xml: string, tag: string, value: string) {
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`)
  const replacement = `<${tag}><language id="${LANGUAGE_ID}"><![CDATA[${cdata(value)}]]></language></${tag}>`
  return pattern.test(xml) ? xml.replace(pattern, replacement) : xml
}

/** Pola tylko do odczytu - PUT z nimi konczy sie bledem walidacji. */
export function stripReadOnly(xml: string) {
  return xml
    .replace(/<manufacturer_name[\s\S]*?<\/manufacturer_name>/g, '')
    .replace(/<quantity[\s\S]*?<\/quantity>/g, '')
}

/**
 * Adres produktu w sklepie.
 *
 * NFD nie rozklada "l" z kreska, wiec bez tej podmiany "stol" gubi cala litere
 * i w adresie zostaje "sto".
 */
export function slugify(value: string) {
  return (
    value
      .replace(/ł/g, 'l')
      .replace(/Ł/g, 'L')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'produkt'
  )
}

/** Nazwa zasobu wielojezycznego z odpowiedzi JSON. */
export function localized(value: unknown): string {
  if (Array.isArray(value)) return String((value[0] as any)?.value ?? '')
  if (value && typeof value === 'object') return String((value as any).value ?? '')
  return String(value ?? '')
}
