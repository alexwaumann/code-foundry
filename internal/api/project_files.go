package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// worktreeFilesEvent maps project.WorktreeFilesChanged (see eventToProto).
func worktreeFilesEvent(e project.WorktreeFilesChanged) *v1.ProjectEvent {
	files := make([]*v1.ChangedFile, len(e.Files))
	for i, f := range e.Files {
		files[i] = &v1.ChangedFile{Path: f.Path, Op: fileOpToProto[f.Op]}
	}
	return &v1.ProjectEvent{Event: &v1.ProjectEvent_WorktreeFilesChanged{WorktreeFilesChanged: &v1.WorktreeFilesChanged{
		ProjectId: e.ProjectID, Path: e.Path, Files: files, Truncated: e.Truncated,
	}}}
}

var fileOpToProto = map[project.FileOp]v1.FileOp{
	project.FileCreated:  v1.FileOp_FILE_OP_CREATED,
	project.FileModified: v1.FileOp_FILE_OP_MODIFIED,
	project.FileRemoved:  v1.FileOp_FILE_OP_REMOVED,
	project.FileRenamed:  v1.FileOp_FILE_OP_RENAMED,
}
