"""
Módulo de Gerenciamento de Banco de Dados Local (SQLite)
========================================================
Responsável por persistir metadados dos artigos, coleções,
tags, DOIs, URLs e referências bibliográficas.
"""

import sqlite3
import os
from typing import List, Dict, Any, Optional

DB_NAME = "academic_library.db"


def get_connection():
    """Retorna uma conexão ativa com o banco SQLite com Row factory."""
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Inicializa as tabelas do banco de dados caso não existam."""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS references_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        authors TEXT NOT NULL,
        publication_year INTEGER,
        journal TEXT,
        volume TEXT,
        issue TEXT,
        pages TEXT,
        doi TEXT,
        url TEXT,
        abstract TEXT,
        tags TEXT,
        collection TEXT DEFAULT 'Geral',
        doc_type TEXT DEFAULT 'Artigo de Periódico',
        filename TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        color TEXT DEFAULT '#3b82f6',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Popula coleções padrão se vazia
    cursor.execute("SELECT COUNT(*) as count FROM collections")
    if cursor.fetchone()['count'] == 0:
        default_collections = [
            ('Artigos Metodologia', 'Artigos de metodologia científica, epistemologia e pesquisa qualitativa/quantitativa', '#3b82f6'),
            ('Matriz C.H.A.', 'Estudos sobre Competências, Habilidades e Atitudes na gestão de pessoas', '#10b981'),
            ('Neurociência', 'Pesquisas em neurociência cognitiva, aprendizagem e tomada de decisão', '#8b5cf6'),
            ('Geral', 'Coleção padrão para artigos diversos sem categoria específica', '#6b7280')
        ]
        cursor.executemany(
            "INSERT INTO collections (name, description, color) VALUES (?, ?, ?)",
            default_collections
        )

    conn.commit()
    conn.close()


def insert_reference(data: Dict[str, Any]) -> int:
    """Insere um novo artigo/referência no banco de dados e retorna seu ID."""
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    INSERT INTO references_catalog (
        title, authors, publication_year, journal, volume, issue,
        pages, doi, url, abstract, tags, collection, doc_type, filename
    ) VALUES (
        :title, :authors, :publication_year, :journal, :volume, :issue,
        :pages, :doi, :url, :abstract, :tags, :collection, :doc_type, :filename
    )
    """

    # Garantir defaults para campos ausentes
    payload = {
        'title': data.get('title', 'Sem título'),
        'authors': data.get('authors', 'Autor desconhecido'),
        'publication_year': int(data.get('publication_year', 2024)) if data.get('publication_year') else None,
        'journal': data.get('journal', ''),
        'volume': data.get('volume', ''),
        'issue': data.get('issue', ''),
        'pages': data.get('pages', ''),
        'doi': data.get('doi', ''),
        'url': data.get('url', ''),
        'abstract': data.get('abstract', ''),
        'tags': data.get('tags', ''),
        'collection': data.get('collection', 'Geral'),
        'doc_type': data.get('doc_type', 'Artigo de Periódico'),
        'filename': data.get('filename', '')
    }

    cursor.execute(query, payload)
    new_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return new_id


def get_all_references(collection: Optional[str] = None, search_term: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Retorna referências cadastradas, com filtros opcionais por coleção ou termo de busca
    (pesquisa em título, autores, periódico, DOI e tags).
    """
    conn = get_connection()
    cursor = conn.cursor()

    query = "SELECT * FROM references_catalog WHERE 1=1"
    params: List[Any] = []

    if collection and collection != 'Todas':
        query += " AND collection = ?"
        params.append(collection)

    if search_term and search_term.strip():
        term = f"%{search_term.strip()}%"
        query += " AND (title LIKE ? OR authors LIKE ? OR journal LIKE ? OR tags LIKE ? OR doi LIKE ?)"
        params.extend([term, term, term, term, term])

    query += " ORDER BY created_at DESC"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    result = [dict(row) for row in rows]
    conn.close()
    return result


def get_reference_by_id(ref_id: int) -> Optional[Dict[str, Any]]:
    """Busca uma referência específica pelo ID."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM references_catalog WHERE id = ?", (ref_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def update_reference(ref_id: int, data: Dict[str, Any]) -> bool:
    """Atualiza os campos de uma referência."""
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    UPDATE references_catalog SET
        title = :title,
        authors = :authors,
        publication_year = :publication_year,
        journal = :journal,
        volume = :volume,
        issue = :issue,
        pages = :pages,
        doi = :doi,
        url = :url,
        abstract = :abstract,
        tags = :tags,
        collection = :collection,
        doc_type = :doc_type,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = :id
    """

    payload = {
        'id': ref_id,
        'title': data.get('title', ''),
        'authors': data.get('authors', ''),
        'publication_year': data.get('publication_year'),
        'journal': data.get('journal', ''),
        'volume': data.get('volume', ''),
        'issue': data.get('issue', ''),
        'pages': data.get('pages', ''),
        'doi': data.get('doi', ''),
        'url': data.get('url', ''),
        'abstract': data.get('abstract', ''),
        'tags': data.get('tags', ''),
        'collection': data.get('collection', 'Geral'),
        'doc_type': data.get('doc_type', 'Artigo de Periódico'),
    }

    cursor.execute(query, payload)
    affected = cursor.rowcount
    conn.commit()
    conn.close()
    return affected > 0


def delete_reference(ref_id: int) -> bool:
    """Remove uma referência do banco de dados."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM references_catalog WHERE id = ?", (ref_id,))
    affected = cursor.rowcount
    conn.commit()
    conn.close()
    return affected > 0


def get_all_collections() -> List[Dict[str, Any]]:
    """Retorna todas as coleções cadastradas com a contagem de itens em cada uma."""
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    SELECT c.name, c.description, c.color, COUNT(r.id) as item_count
    FROM collections c
    LEFT JOIN references_catalog r ON c.name = r.collection
    GROUP BY c.id
    ORDER BY c.name ASC
    """
    cursor.execute(query)
    rows = cursor.fetchall()
    result = [dict(row) for row in rows]
    conn.close()
    return result


def add_collection(name: str, description: str = '', color: str = '#3b82f6') -> bool:
    """Cria uma nova coleção."""
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO collections (name, description, color) VALUES (?, ?, ?)",
            (name.strip(), description.strip(), color)
        )
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        success = False
    finally:
        conn.close()
    return success


def get_catalog_stats() -> Dict[str, Any]:
    """Retorna estatísticas gerais da biblioteca acadêmica."""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) as total_articles FROM references_catalog")
    total_articles = cursor.fetchone()['total_articles']

    cursor.execute("SELECT COUNT(DISTINCT collection) as total_collections FROM references_catalog")
    total_collections = cursor.fetchone()['total_collections']

    cursor.execute("SELECT MIN(publication_year) as min_year, MAX(publication_year) as max_year FROM references_catalog WHERE publication_year IS NOT NULL")
    years_row = cursor.fetchone()

    conn.close()
    return {
        'total_articles': total_articles,
        'total_collections': total_collections,
        'min_year': years_row['min_year'],
        'max_year': years_row['max_year']
    }
