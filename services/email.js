import sgMail from '@sendgrid/mail';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'info@cognerax.com';

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('📧 SendGrid configured');
} else {
  console.warn('⚠️  SENDGRID_API_KEY not set — emails will be logged to console');
}

export async function sendOTPEmail(to, otp) {
  const msg = {
    to,
    from: FROM_EMAIL,
    subject: '🍳 Breakfast Ordering — Your Verification Code',
    text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0f0f1a; border-radius: 16px; color: #e2e8f0;">
        <h1 style="text-align: center; font-size: 1.5rem; margin-bottom: 8px;">🍳 Breakfast Ordering</h1>
        <p style="text-align: center; color: #94a3b8; margin-bottom: 28px;">Your verification code</p>
        <div style="text-align: center; background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15)); border: 1px solid rgba(99,102,241,0.3); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <span style="font-size: 2.5rem; font-weight: 700; letter-spacing: 12px; color: #818cf8;">${otp}</span>
        </div>
        <p style="text-align: center; color: #64748b; font-size: 0.85rem;">This code expires in <strong>10 minutes</strong>.</p>
        <p style="text-align: center; color: #475569; font-size: 0.8rem; margin-top: 24px;">If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `,
  };

  if (!SENDGRID_API_KEY) {
    console.log(`📧 [DEV] OTP for ${to}: ${otp}`);
    return;
  }

  try {
    await sgMail.send(msg);
    console.log(`📧 OTP sent to ${to}`);
  } catch (err) {
    console.error('SendGrid error:', err.response?.body || err.message);
    throw new Error('Failed to send verification email');
  }
}
