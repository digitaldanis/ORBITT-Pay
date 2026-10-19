# Address derivation

Authorship: W-Digital (hallo@w-digital.eu)

The service derives receiving addresses from merchant-provided **public account extended keys**. It rejects private extended keys. Merchants retain their seed phrases and signing keys outside ORBITT PAY.

## Account key requirements

- Bitcoin and Litecoin use account-level BIP84 public keys for account 0: `m/84'/coin_type'/0'`.
- EVM uses the BIP44 account-level public key at `m/44'/60'/0'`.
- The service derives only non-hardened receiving children below the account key and records the complete path on each invoice.
- Supported Bitcoin-family extended public key versions are `xpub`, `tpub`, `zpub`, and `vpub`. Litecoin's `Ltub` version is not accepted because it identifies a legacy BIP44 serialization, not a BIP84 native SegWit account.

## Address allocation

The derivation functions are deterministic, but index allocation must be serialized per merchant and network. Reserve the next index in a database transaction and keep a unique constraint across open invoice addresses. Do not release an address while a payment is detected or confirming. Persist the index and derivation path so an operator can audit the assignment.

## Current coverage

- Bitcoin and Litecoin native SegWit P2WPKH (`bc1`/`tb1`, `ltc1`/`tltc1`).
- EVM account paths, with EIP-55 checksum casing.
- Bitcoin Taproot and chain watchers are separate follow-up work; these functions currently derive receive addresses only.
