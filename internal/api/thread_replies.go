package api

import (
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Reply marks and relations on thread-to-thread messages (docs/notes/thread-reply-mark.md).

var replyToProto = map[thread.Reply]v1.ReplyMark{
	thread.ReplyWanted: v1.ReplyMark_REPLY_MARK_WANTED,
	thread.ReplyNone:   v1.ReplyMark_REPLY_MARK_NONE,
}

// replyFromProto maps a request's mark; UNSPECIFIED is none given ("").
var replyFromProto = map[v1.ReplyMark]thread.Reply{
	v1.ReplyMark_REPLY_MARK_WANTED: thread.ReplyWanted,
	v1.ReplyMark_REPLY_MARK_NONE:   thread.ReplyNone,
}

var relationToProto = map[thread.Relation]v1.ThreadRelation{
	thread.RelationLead:   v1.ThreadRelation_THREAD_RELATION_LEAD,
	thread.RelationWorker: v1.ThreadRelation_THREAD_RELATION_WORKER,
	thread.RelationOther:  v1.ThreadRelation_THREAD_RELATION_OTHER,
}

// sentToProto maps a note's record of a sent message; nil for none.
func sentToProto(s *thread.SentMessage) *v1.ThreadMessageSent {
	if s == nil {
		return nil
	}
	p := &v1.ThreadMessageSent{ToThreadId: s.ToThreadID, ToName: s.ToName, Relation: relationToProto[s.Relation], Reply: replyToProto[s.Reply],
		ItemId: s.ItemID, Ordinal: s.Ordinal, ReplyItemId: s.ReplyItemID, Unanswered: s.Unanswered}
	if !s.RepliedAt.IsZero() {
		p.RepliedAt = timestamppb.New(s.RepliedAt)
	}
	return p
}
