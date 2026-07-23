UPDATE workbench_settings
SET
  settings_json = json_set(
    settings_json,
    '$.profiles[0].targets',
    json_insert(
      json_extract(settings_json, '$.profiles[0].targets'),
      '$[#]',
      json('{"symbol":"ORCL","name":"Oracle","market":"US","role":"driver","analysis":"signal"}')
    )
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND json_type(settings_json, '$.profiles[0].targets') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(settings_json, '$.profiles[0].targets')
    WHERE json_extract(value, '$.symbol') = 'ORCL'
  );
