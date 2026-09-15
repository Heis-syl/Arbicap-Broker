# Manual Fixes — Apply These to Your Machine

## 1. Remove Email Verification from Registration
Open `routes/auth.js`, find the register route and:

### Change email_verified to true on insert:
Find:
  email_verified: false
Change to:
  email_verified: true

### Comment out the sendEmail call after registration:
Find the block that looks like:
  await sendEmail({
    to: email,
    subject: 'Verify your...',
    template: 'email-verify',
    ...
  });
Comment it all out with /* ... */ or delete it.

---

## 2. Admin Login (bbrorien@gmail.com / Faseless32.)
Run this in Supabase SQL Editor:

  UPDATE public.users 
  SET role = 'admin', 
      email_verified = true,
      status = 'active'
  WHERE email = 'bbrorien@gmail.com';

---

## 3. Fix Holdings table ID in dashboard
Open dashboard.html and find the holdings <tbody> tag.
Add id="holdings-tbody" to it:
  <tbody id="holdings-tbody">

Find the activity list container and add:
  id="activity-list"

---

## 4. After all fixes, restart server:
  node server.js
