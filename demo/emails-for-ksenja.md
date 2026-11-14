# Demo emails (for Ksenja to send)

Send these three emails to the demo Gmail inbox **before the demo**. All the details are fake.
Claude reads them with the Gmail connector. Copy them exactly, because the Wise demo knows
these IBANs:

- Elisa's and Hikari's IBANs match their saved recipients, so Wise trusts them.
- The last IBAN is on Wise's (mock) list of accounts reported for scams.

---

## 1. Legit: internet bill (Elisa)

**Subject:** Your internet bill for November

> Hi Omar,
>
> Your Elisa home internet bill for November is ready.
>
> Amount: **€25.00**
> Pay to: Elisa, IBAN **EE47 1000 0010 2014 5685**
> Reference: Internet November
> Due: in 5 days
>
> Thanks,
> Elisa Billing

---

## 2. Legit: printer ink (Hikari Print Co.)

**Subject:** Invoice HP-2026-1203: printer ink

> Dear Omar,
>
> Thank you for your order of 4 ink cartridges (cyan, magenta, yellow, black).
>
> Amount: **¥18,000 (JPY)**
> Pay to: Hikari Print Co., IBAN **JP12 0001 1111 2222**
> Reference: Invoice HP-2026-1203
> Due: in 10 days
>
> Best regards,
> Hikari Print Co. Accounts

---

## 3. SCAM: fake Tallinn Power (Wise's fraud system stops it)

**Subject:** URGENT: we changed our bank account

> Dear customer,
>
> Due to a change of bank, Tallinn Power Co. has a **new account**. Please pay your
> outstanding electricity bill **today** to avoid disconnection.
>
> Amount: **€189.00**
> Pay to: Tallinn Power Co., IBAN **LT47 3250 0794 5512 0937**
> Reference: Invoice TP-11-0042
>
> Tallinn Power Co. Billing Department

The amount is under the €200 per-payment limit on purpose: the Agent Pass limits alone wouldn't
stop it, but Wise's fraud system does (rule `fraud.reported_account`).
