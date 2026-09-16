-- Update sessions using the previous standard price; preserve custom prices.
UPDATE sessions SET price_paise = 70000 WHERE price_paise = 29900;
