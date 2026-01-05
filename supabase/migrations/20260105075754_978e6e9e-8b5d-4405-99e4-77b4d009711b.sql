-- Create trigger function to enforce 10-document limit per user
CREATE OR REPLACE FUNCTION check_document_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM documents WHERE user_id = NEW.user_id) >= 10 THEN
    RAISE EXCEPTION 'Document limit reached. Maximum 10 documents allowed per user.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on documents table
CREATE TRIGGER enforce_document_limit
  BEFORE INSERT ON documents
  FOR EACH ROW
  EXECUTE FUNCTION check_document_limit();