package browser

// BlameHistory is the memory watch asking about a swell of Chrome's own process, for tests.
func (s *Store) BlameHistory() bool {
	s.mu.Lock()
	in := s.chrome
	s.mu.Unlock()
	return in != nil && s.blameHistory(in)
}
