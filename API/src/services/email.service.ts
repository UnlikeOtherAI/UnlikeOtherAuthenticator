type EmailSendParams = {
  to: string;
  subject: string;
  text: string;
};

async function sendEmail(params: EmailSendParams): Promise<void> {
  // Email provider integration comes later. For now, log a minimal, user-safe payload.
  // Do not log full links/tokens in production.
  if (process.env.NODE_ENV !== 'production') {
    console.info('[email:dev]', { to: params.to, subject: params.subject, text: params.text });
  }
}

export async function sendLoginLinkEmail(params: { to: string; link: string }): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: 'Your login link',
    text: `Use this link to log in: ${params.link}`,
  });
}

export async function sendVerifyEmailSetPasswordEmail(params: {
  to: string;
  link: string;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: 'Verify your email',
    text: `Verify your email and set your password: ${params.link}`,
  });
}
