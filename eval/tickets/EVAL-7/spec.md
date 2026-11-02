# EVAL-7 — Optional email for the receipt

- AC-1: the cart has an optional "Email for receipt" field; when it holds an invalid address such as "name@", clicking "Checkout" shows "Enter a valid email address" and does not confirm the order. With an empty field, the checkout works as before.
- AC-2: when the field holds a valid address such as "ana@example.com", clicking "Checkout" confirms the order and shows "Receipt sent to ana@example.com".
