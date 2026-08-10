ALTER TABLE magic_link_tokens ADD COLUMN browser_binding_hash TEXT CHECK (
  browser_binding_hash IS NULL OR (
    length(browser_binding_hash) = 64
    AND browser_binding_hash NOT GLOB '*[^0-9a-f]*'
  )
);
