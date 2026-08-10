/**
 * Sprawdzenie konfiguracji SMTP - polaczenie, logowanie i (opcjonalnie)
 * wyslanie wiadomosci testowej.
 *
 * Po co osobno: panel pokazuje tylko "nie udalo sie wyslac", a przyczyny sa
 * rozne i wymagaja roznych napraw - zablokowany port, zle haslo, odrzucony
 * adres nadawcy. `verify()` rozdziela pierwsze dwie od reszty.
 *
 * Sprawdza KAZDA aktywna konfiguracje po kolei, bo od zmiany na ustawienia
 * per sklep jest ich kilka i kazda ma wlasne konto.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/check-smtp.js
 *   SEND_TO=adres@example.com - wyslij tez wiadomosc testowa
 */
import nodemailer from 'nodemailer'
import { PrismaClient } from '@prisma/client'
import { decrypt } from '../lib/encryption'

const prisma = new PrismaClient()

async function main() {
  const settings = await prisma.emailSettings.findMany({
    where: { isActive: true },
    include: { shop: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  })

  if (settings.length === 0) {
    console.log(JSON.stringify({ blad: 'Brak aktywnych konfiguracji SMTP' }, null, 2))
    return
  }

  const results = []
  for (const item of settings) {
    const label = item.shop?.name ?? '(zapasowa)'
    const transporter = nodemailer.createTransport({
      host: item.host,
      port: item.port,
      secure: item.secure,
      auth: { user: item.user, pass: decrypt(item.password) },
      // Bez tego skrypt wisi minutami na zablokowanym porcie, zamiast
      // powiedziec wprost, ze polaczenie nie przechodzi.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    })

    const result: Record<string, unknown> = {
      konfiguracja: label,
      serwer: `${item.host}:${item.port}`,
      nadawca: item.fromEmail,
      secure: item.secure,
    }

    try {
      await transporter.verify()
      result.polaczenie = 'OK'
    } catch (error) {
      result.polaczenie = 'BŁĄD'
      result.szczegoly = error instanceof Error ? error.message : String(error)
      results.push(result)
      continue
    }

    const sendTo = process.env.SEND_TO
    if (sendTo) {
      try {
        const info = await transporter.sendMail({
          from: `"${item.fromName || label}" <${item.fromEmail}>`,
          to: sendTo,
          subject: `Test SMTP — ${label}`,
          text: `Wiadomość testowa z konfiguracji „${label}" (${item.host}:${item.port}).`,
        })
        result.wyslano = info.messageId
      } catch (error) {
        result.wyslano = 'BŁĄD'
        result.bladWysylki = error instanceof Error ? error.message : String(error)
      }
    }

    results.push(result)
  }

  console.log(JSON.stringify(results, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
