#!/bin/bash

# Test script for merge-duckdb tool

echo "Creating test databases..."

# Create first test database
cat > /tmp/create_db1.sql << 'EOF'
CREATE TABLE entities (
  name VARCHAR PRIMARY KEY,
  entityType VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE observations (
  entityName VARCHAR,
  content VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entityName) REFERENCES entities(name),
  PRIMARY KEY (entityName, content)
);

CREATE TABLE relations (
  from_entity VARCHAR,
  to_entity VARCHAR,
  relationType VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_entity) REFERENCES entities(name),
  FOREIGN KEY (to_entity) REFERENCES entities(name),
  PRIMARY KEY (from_entity, to_entity, relationType)
);

INSERT INTO entities (name, entityType, created_at) VALUES 
  ('Alice', 'Person', '2024-01-01 00:00:00'),
  ('Bob', 'Person', '2024-01-02 00:00:00');

INSERT INTO observations (entityName, content, created_at) VALUES 
  ('Alice', 'Works at Acme Corp', '2024-01-01 00:00:00'),
  ('Bob', 'Lives in NYC', '2024-01-02 00:00:00');

INSERT INTO relations (from_entity, to_entity, relationType, created_at) VALUES 
  ('Alice', 'Bob', 'knows', '2024-01-03 00:00:00');
EOF

# Create second test database
cat > /tmp/create_db2.sql << 'EOF'
CREATE TABLE entities (
  name VARCHAR PRIMARY KEY,
  entityType VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE observations (
  entityName VARCHAR,
  content VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entityName) REFERENCES entities(name),
  PRIMARY KEY (entityName, content)
);

CREATE TABLE relations (
  from_entity VARCHAR,
  to_entity VARCHAR,
  relationType VARCHAR,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_entity) REFERENCES entities(name),
  FOREIGN KEY (to_entity) REFERENCES entities(name),
  PRIMARY KEY (from_entity, to_entity, relationType)
);

INSERT INTO entities (name, entityType, created_at) VALUES 
  ('Alice', 'User', '2024-02-01 00:00:00'),  -- Same entity with different type and timestamp
  ('Charlie', 'Person', '2024-02-02 00:00:00');

INSERT INTO observations (entityName, content, created_at) VALUES 
  ('Alice', 'Likes coffee', '2024-02-01 00:00:00'),  -- New observation for Alice
  ('Charlie', 'Plays guitar', '2024-02-02 00:00:00');

INSERT INTO relations (from_entity, to_entity, relationType, created_at) VALUES 
  ('Alice', 'Charlie', 'knows', '2024-02-03 00:00:00');
EOF

# Create databases using duckdb CLI if available, otherwise skip
if command -v duckdb &> /dev/null; then
    echo "Creating db1.db..."
    duckdb /tmp/test_db1.db < /tmp/create_db1.sql
    
    echo "Creating db2.db..."
    duckdb /tmp/test_db2.db < /tmp/create_db2.sql
    
    echo "Running merge..."
    node dist/tools/merge-duckdb.mjs /tmp/test_db1.db /tmp/test_db2.db /tmp/test_merged.db
    
    echo -e "\nMerge complete! Checking results..."
    
    echo -e "\nEntities in merged database:"
    duckdb /tmp/test_merged.db -c "SELECT * FROM entities ORDER BY name;"
    
    echo -e "\nObservations in merged database:"
    duckdb /tmp/test_merged.db -c "SELECT * FROM observations ORDER BY entityName, content;"
    
    echo -e "\nRelations in merged database:"
    duckdb /tmp/test_merged.db -c "SELECT * FROM relations ORDER BY from_entity, to_entity;"
    
    # Cleanup
    rm -f /tmp/test_db1.db /tmp/test_db2.db /tmp/test_merged.db /tmp/create_db1.sql /tmp/create_db2.sql
else
    echo "DuckDB CLI not found. Please install it to run this test."
    echo "You can install it with: brew install duckdb"
fi