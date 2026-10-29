package dictate

// Whisper was trained on subtitled video, so near-silence, breath and room noise come
// back as the things subtitles say when nobody speaks. A phrase whose whole text,
// normalized (lower case, punctuation dropped, spaces collapsed), is one of
// silenceHallucinations is dropped. A phrase containing one of creditMarkers anywhere is
// dropped too: nobody dictates a subtitle credit. Add entries as they turn up in use.
var silenceHallucinations = []string{
	"thank you",
	"thank you very much",
	"thank you so much",
	"thanks",
	"thanks for watching",
	"thank you for watching",
	"thanks for watching and see you next time",
	"thank you for watching and see you next time",
	"see you next time",
	"see you in the next video",
	"please subscribe",
	"please subscribe to my channel",
	"subscribe to my channel",
	"like and subscribe",
	"dont forget to like and subscribe",
	"bye",
	"bye bye",
	"you",
	"music",
	"applause",
	"laughter",
	"silence",
	"blank audio",
	"no speech",
	"inaudible",
	"the end",
}

var creditMarkers = []string{
	"subtitles by",
	"subtitled by",
	"captions by",
	"captioned by",
	"transcribed by",
	"transcription by",
	"translated by",
	"amara.org",
	"www.mooji.org",
	"thank you for watching!",
}
