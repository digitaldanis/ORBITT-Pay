const en = {
  secureCheckout: 'Secure checkout',
  paying: 'Pay',
  order: 'Order',
  chooseTitle: 'How would you like to pay?',
  chooseHint: 'Pick a coin and network. We lock the exact amount for you as soon as you continue.',
  networks: 'networks',
  selectNetwork: 'Choose network',
  preparing: 'Locking your price…',
  sendExactly: 'Send exactly',
  sendRemaining: 'Send the remaining',
  orderTotal: 'Order total',
  copy: 'Copy',
  copied: 'Copied',
  copyAddress: 'Copy address',
  amount: 'Amount',
  address: 'Address',
  openWallet: 'Open in wallet',
  scanWithWallet: 'Scan with your wallet app',
  sendOnlyOn: 'Send only {asset} on {network}. Other networks or tokens cannot be recovered.',
  sharedAddressNote: 'The amount identifies your payment. Send it in one transfer, exactly as shown.',
  directToMerchant: 'Funds go directly to the merchant',
  timeLeft: 'Time left',
  steps: ['Waiting', 'Detected', 'Confirming', 'Paid'],
  status: {
    created: 'Choose a coin', awaiting_payment: 'Waiting for payment', detected: 'Payment detected',
    confirming: 'Confirming', paid: 'Paid', underpaid: 'Partially paid', overpaid: 'Overpaid',
    expired: 'Expired', late_payment: 'Late payment', cancelled: 'Cancelled',
  },
  underpaidNotice: 'We received {received} {asset}. Send the remaining {remaining} {asset} to the same address.',
  overpaidNotice: 'You sent more than required. The merchant will review the difference.',
  confirmingNotice: 'Your payment is on the way. This page updates automatically. You can close it.',
  paidTitle: 'Payment complete',
  paidText: '{merchant} received your payment.',
  continue: 'Back to {merchant}',
  expiredTitle: 'This payment expired',
  expiredText: 'The price was locked for a limited time. If you already sent funds, contact the shop with your order number.',
  lateTitle: 'Payment arrived late',
  lateText: 'Your transfer arrived after the payment window closed. The shop has been notified and will contact you.',
  cancelledTitle: 'Payment cancelled',
  cancelledText: 'This payment request was cancelled. No funds were taken.',
  backToShop: 'Return to shop',
  cancel: 'Cancel payment',
  cancelling: 'Cancelling…',
  changeCoin: 'Choose another coin',
  live: 'Live status',
  loading: 'Loading payment…',
  unavailable: 'Checkout unavailable',
  invalidLink: 'This checkout link is invalid.',
  retry: 'Try again',
  noOptions: 'This shop has no payment methods available right now. Please try again later.',
  copyUnavailable: 'Copying is not available in this browser. Select the text to copy it.',
  poweredBy: 'Powered by',
  tagline: 'Payments for every chain',
  viewTransaction: 'View transaction',
};

type Messages = typeof en;

const de: Messages = {
  secureCheckout: 'Sicherer Checkout',
  paying: 'Zahlung an',
  order: 'Bestellung',
  chooseTitle: 'Womit möchtest du bezahlen?',
  chooseHint: 'Wähle Kryptowährung und Netzwerk. Wir fixieren den genauen Betrag, sobald du fortfährst.',
  networks: 'Netzwerke',
  selectNetwork: 'Netzwerk wählen',
  preparing: 'Preis wird fixiert…',
  sendExactly: 'Sende genau',
  sendRemaining: 'Sende den Restbetrag',
  orderTotal: 'Bestellsumme',
  copy: 'Kopieren',
  copied: 'Kopiert',
  copyAddress: 'Adresse kopieren',
  amount: 'Betrag',
  address: 'Adresse',
  openWallet: 'In Wallet öffnen',
  scanWithWallet: 'Mit deiner Wallet-App scannen',
  sendOnlyOn: 'Sende nur {asset} über {network}. Andere Netzwerke oder Token gehen verloren.',
  sharedAddressNote: 'Der Betrag ordnet deine Zahlung zu. Sende ihn in einer Überweisung, genau wie angezeigt.',
  directToMerchant: 'Das Geld geht direkt an den Händler',
  timeLeft: 'Verbleibend',
  steps: ['Warten', 'Erkannt', 'Bestätigung', 'Bezahlt'],
  status: {
    created: 'Coin wählen', awaiting_payment: 'Warte auf Zahlung', detected: 'Zahlung erkannt',
    confirming: 'Wird bestätigt', paid: 'Bezahlt', underpaid: 'Teilweise bezahlt', overpaid: 'Überbezahlt',
    expired: 'Abgelaufen', late_payment: 'Verspätete Zahlung', cancelled: 'Storniert',
  },
  underpaidNotice: 'Wir haben {received} {asset} erhalten. Sende die restlichen {remaining} {asset} an dieselbe Adresse.',
  overpaidNotice: 'Du hast mehr als nötig gesendet. Der Händler prüft die Differenz.',
  confirmingNotice: 'Deine Zahlung ist unterwegs. Diese Seite aktualisiert sich automatisch. Du kannst sie schließen.',
  paidTitle: 'Zahlung abgeschlossen',
  paidText: '{merchant} hat deine Zahlung erhalten.',
  continue: 'Zurück zu {merchant}',
  expiredTitle: 'Diese Zahlung ist abgelaufen',
  expiredText: 'Der Preis war nur begrenzt fixiert. Falls du schon gesendet hast, kontaktiere den Shop mit deiner Bestellnummer.',
  lateTitle: 'Zahlung kam zu spät',
  lateText: 'Deine Überweisung kam nach Ablauf des Zahlungsfensters an. Der Shop wurde informiert und meldet sich bei dir.',
  cancelledTitle: 'Zahlung storniert',
  cancelledText: 'Diese Zahlungsanfrage wurde storniert. Es wurde nichts abgebucht.',
  backToShop: 'Zurück zum Shop',
  cancel: 'Zahlung abbrechen',
  cancelling: 'Wird abgebrochen…',
  changeCoin: 'Andere Kryptowährung wählen',
  live: 'Live-Status',
  loading: 'Zahlung wird geladen…',
  unavailable: 'Checkout nicht verfügbar',
  invalidLink: 'Dieser Checkout-Link ist ungültig.',
  retry: 'Erneut versuchen',
  noOptions: 'Dieser Shop bietet gerade keine Zahlungsmethoden an. Bitte versuche es später erneut.',
  copyUnavailable: 'Kopieren ist in diesem Browser nicht verfügbar. Markiere den Text zum Kopieren.',
  poweredBy: 'Bereitgestellt von',
  tagline: 'Payments for every chain',
  viewTransaction: 'Transaktion ansehen',
};

export type Locale = 'en' | 'de';
export const locale: Locale = typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
export const t: Messages = locale === 'de' ? de : en;

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

export function formatFiat(amount: string, currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) return `${amount} ${currency}`;
  try {
    // Display only: the authoritative amount stays a string end to end.
    return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-US', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}
