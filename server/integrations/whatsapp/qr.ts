import QRCode from 'qrcode'

export const generateQR = async (qr: string): Promise<string> => {
  try {
    // Generate QR code as data URL
    const qrDataUrl = await QRCode.toDataURL(qr)
    return qrDataUrl
  } catch (error) {
    console.error('Error generating QR code:', error)
    throw error
  }
} 